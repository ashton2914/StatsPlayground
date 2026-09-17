use super::graph_new_lod::{GraphDomain, SourcePoint};
use super::graph_new_text::{glyph_index, numeric_atlas, ATLAS_HEIGHT, ATLAS_WIDTH};
use super::graph_new_ticks::{normalized, numeric_ticks, validate_domain};
use super::graph_new_transport_service::{
    session_renderer, SyntheticFrame, SyntheticFrameRenderer,
};
use crate::error::AppError;
use sha2::{Digest, Sha256};
use crate::models::graph_new::GraphNewGpuCacheStats;

pub(crate) const MAX_SCENE_POINTS: usize = 1_000_000;
const GRID: [f32; 4] = [226.0 / 255.0, 232.0 / 255.0, 240.0 / 255.0, 1.0];
const INK: [f32; 4] = [71.0 / 255.0, 85.0 / 255.0, 105.0 / 255.0, 1.0];
const BLUE: [f32; 4] = [31.0 / 255.0, 111.0 / 255.0, 235.0 / 255.0, 1.0];

/// Logical dimensions; output is ceil(width * DPR) by ceil(height * DPR) RGBA8.
pub(crate) struct GraphNewScene {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) device_pixel_ratio: f64,
    pub(crate) domain: GraphDomain,
    pub(crate) points: Vec<SourcePoint>,
}

impl GraphNewScene {
    pub(crate) fn physical_size(&self) -> Result<(u32, u32), AppError> {
        let ratio = self.device_pixel_ratio;
        let width = (self.width as f64 * ratio).ceil();
        let height = (self.height as f64 * ratio).ceil();
        if !ratio.is_finite()
            || !(0.5..=8.0).contains(&ratio)
            || self.width < 96
            || self.height < 64
            || width > 3840.0
            || height > 2160.0
        {
            return Err(AppError::InvalidParam(
                "graph-new invalid scene dimensions or DPR".into(),
            ));
        }
        validate_domain(self.domain.x_min, self.domain.x_max)?;
        validate_domain(self.domain.y_min, self.domain.y_max)?;
        if self.points.len() > MAX_SCENE_POINTS
            || self
                .points
                .iter()
                .any(|point| !point.x.is_finite() || !point.y.is_finite())
        {
            return Err(AppError::InvalidParam(
                "graph-new invalid scene points".into(),
            ));
        }
        Ok((width as u32, height as u32))
    }

    pub(crate) fn plot_rect(&self) -> crate::models::graph_new::GraphNewPlotRect {
        let [x, y, width, height] = self.plot().map(|value| value as u32);
        crate::models::graph_new::GraphNewPlotRect { x, y, width, height }
    }

    fn plot(&self) -> [f32; 4] {
        let ratio = self.device_pixel_ratio;
        let left = (64.0 * ratio).ceil();
        let top = (16.0 * ratio).ceil();
        let right = ((self.width as f64 - 16.0) * ratio).floor();
        let bottom = ((self.height as f64 - 32.0) * ratio).floor();
        [
            left as f32,
            top as f32,
            (right - left) as f32,
            (bottom - top) as f32,
        ]
    }
}

pub(crate) struct GraphNewRenderer;

impl GraphNewRenderer {
    pub(crate) fn cache_stats() -> Option<GraphNewGpuCacheStats> {
        session_renderer().lock().ok()?.as_ref().map(SyntheticFrameRenderer::cache_stats)
    }

    pub(crate) fn render(scene: &GraphNewScene) -> Result<SyntheticFrame, AppError> {
        scene.physical_size()?;
        let mut guard = session_renderer()
            .lock()
            .map_err(|_| AppError::Stats("graph-new renderer lock poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(pollster::block_on(SyntheticFrameRenderer::new())?);
        }
        let renderer = guard
            .as_mut()
            .ok_or_else(|| AppError::Stats("graph-new session renderer unavailable".into()))?;
        pollster::block_on(renderer.render_scene(scene))
    }
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Mark {
    position: [f32; 2],
    size: [f32; 2],
    color: [f32; 4],
    kind_glyph: [f32; 2],
}

#[derive(Clone, Copy)]
struct PointBasis {
    domain: GraphDomain,
    camera_relative: bool,
}

impl PointBasis {
    fn reference(scene: &GraphNewScene) -> Self {
        let mut domain = GraphDomain { x_min: 0.0, x_max: 0.0, y_min: 0.0, y_max: 0.0 };
        if let Some(first) = scene.points.first() {
            domain = GraphDomain { x_min: first.x, x_max: first.x, y_min: first.y, y_max: first.y };
            for point in &scene.points {
                domain.x_min = domain.x_min.min(point.x);
                domain.x_max = domain.x_max.max(point.x);
                domain.y_min = domain.y_min.min(point.y);
                domain.y_max = domain.y_max.max(point.y);
            }
        }
        Self { domain, camera_relative: false }
    }

    fn position(&self, point: &SourcePoint) -> [f32; 2] {
        [normalized(point.x, self.domain.x_min, self.domain.x_max).clamp(-1.0, 2.0) as f32,
            normalized(point.y, self.domain.y_min, self.domain.y_max).clamp(-1.0, 2.0) as f32]
    }

    fn camera(&self, scene: &GraphNewScene) -> Option<[f32; 4]> {
        let reference = self.domain;
        let camera = scene.domain;
        if self.camera_relative {
            return (reference.x_min == camera.x_min && reference.x_max == camera.x_max
                && reference.y_min == camera.y_min && reference.y_max == camera.y_max)
                .then_some([1.0, 1.0, 0.0, 0.0]);
        }
        let mut affine = [0.0; 4];
        for (axis, minimum, maximum, camera_min, camera_max) in [
            (0, reference.x_min, reference.x_max, camera.x_min, camera.x_max),
            (1, reference.y_min, reference.y_max, camera.y_min, camera.y_max),
        ] {
            let offset = normalized(minimum, camera_min, camera_max);
            let scale = if minimum == maximum { 0.0 } else {
                normalized(maximum, camera_min, camera_max) - offset
            };
            affine[axis] = scale as f32;
            affine[axis + 2] = offset as f32;
        }
        if affine.iter().any(|value| !value.is_finite() || value.is_subnormal()) {
            return None;
        }
        let plot = scene.plot();
        for point in &scene.points {
            let position = self.position(point);
            let expected = [normalized(point.x, camera.x_min, camera.x_max),
                normalized(point.y, camera.y_min, camera.y_max)];
            for axis in 0..2 {
                let product = position[axis] * affine[axis];
                let projected = product + affine[axis + 2];
                let error = (f64::from(projected).clamp(-1.0, 2.0)
                    - expected[axis].clamp(-1.0, 2.0)).abs();
                let rounding = 2.0 * f64::from(f32::EPSILON)
                    * (f64::from(product).abs() + f64::from(affine[axis + 2]).abs());
                if !projected.is_finite() || (error + rounding) * f64::from(plot[axis + 2]) > 0.125 {
                    return None;
                }
            }
        }
        Some(affine)
    }
}

pub(crate) struct ScenePipeline {
    pipeline: wgpu::RenderPipeline,
    bindings: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    instances: wgpu::Buffer,
    capacity: u64,
    decoration_instances: wgpu::Buffer,
    decoration_capacity: u64,
    point_basis: Option<PointBasis>,
    decorations: u32,
    total: u32,
    plot: [u32; 4],
    content_hash: Option<[u8; 32]>,
    uploads: u64,
    hits: u64,
}

pub(crate) fn check_gpu_budget(geometry_bytes: u64, target_bytes: u64, limit: u64) -> Result<(), AppError> {
    if geometry_bytes.checked_add(target_bytes).is_none_or(|bytes| bytes > limit) {
        return Err(AppError::Stats("graph_new_cache_pressure".into()));
    }
    Ok(())
}

impl ScenePipeline {
    pub(crate) fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let uniform = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("graph-new camera uniform"),
            size: 48,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let atlas = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("graph-new numeric-only atlas"),
            size: wgpu::Extent3d {
                width: ATLAS_WIDTH,
                height: ATLAS_HEIGHT,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &atlas,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &numeric_atlas(),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(ATLAS_WIDTH),
                rows_per_image: Some(ATLAS_HEIGHT),
            },
            atlas.size(),
        );
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("graph-new scene bindings"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
            ],
        });
        let bindings = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("graph-new scene bind group"),
            layout: &layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(
                        &atlas.create_view(&Default::default()),
                    ),
                },
            ],
        });
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("graph-new circles and numeric glyphs"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("graph-new scene pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("graph-new scene pipeline"), layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_main"), compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<Mark>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Float32x2] })] },
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_main"), compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })] }),
            multiview_mask: None, cache: None,
        });
        let instances = Self::buffer(device, 40);
        Self {
            pipeline,
            bindings,
            uniform,
            instances,
            capacity: 40,
            decoration_instances: Self::buffer(device, 40),
            decoration_capacity: 40,
            point_basis: None,
            decorations: 0,
            total: 0,
            plot: [0; 4],
            content_hash: None,
            uploads: 0,
            hits: 0,
        }
    }

    fn buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("graph-new bounded scene instances"),
            size,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        })
    }

    pub(crate) fn prepare(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        scene: &GraphNewScene,
    ) -> Result<(), AppError> {
        let (width, height) = scene.physical_size()?;
        let mut digest = Sha256::new();
        digest.update((scene.points.len() as u64).to_le_bytes());
        for point in &scene.points {
            digest.update(point.row_id.to_le_bytes());
            digest.update(point.x.to_le_bytes());
            digest.update(point.y.to_le_bytes());
        }
        let content_hash: [u8; 32] = digest.finalize().into();
        let reused_camera = if self.content_hash == Some(content_hash) {
            self.point_basis.and_then(|basis| basis.camera(scene))
        } else { None };
        let (basis, camera) = if let Some(camera) = reused_camera {
            (self.point_basis, camera)
        } else {
            let reference = PointBasis::reference(scene);
            if let Some(camera) = reference.camera(scene) {
                (Some(reference), camera)
            } else {
                (Some(PointBasis { domain: scene.domain, camera_relative: true }), [1.0, 1.0, 0.0, 0.0])
            }
        };
        let plot = scene.plot();
        let ratio = scene.device_pixel_ratio as f32;
        let mut marks = Vec::with_capacity(1024);
        for tick in numeric_ticks(scene.domain.x_min, scene.domain.x_max)? {
            let horizontal = plot[0] + tick.position as f32 * plot[2];
            marks.push(rect([horizontal, plot[1]], [ratio, plot[3]], GRID));
        }
        for tick in numeric_ticks(scene.domain.y_min, scene.domain.y_max)? {
            let vertical = plot[1] + (1.0 - tick.position as f32) * plot[3];
            marks.push(rect([plot[0], vertical], [plot[2], ratio], GRID));
        }
        for horizontal in [true, false] {
            for (label, position) in axis_labels(scene, horizontal)? {
                text(&mut marks, &label, position, (2.0 * ratio).max(1.0));
            }
        }
        marks.push(rect(
            [plot[0] - ratio, plot[1]],
            [ratio, plot[3] + ratio],
            INK,
        ));
        marks.push(rect(
            [plot[0] - ratio, plot[1] + plot[3]],
            [plot[2] + ratio, ratio],
            INK,
        ));
        self.decorations = marks.len() as u32;
        self.total = scene.points.len() as u32;
        if marks.len() > 1024 { return Err(AppError::Stats("graph_new_cache_pressure".into())); }
        self.plot = plot.map(|value| value as u32);
        let bytes = bytemuck::cast_slice(&marks);
        if bytes.len() as u64 > self.decoration_capacity {
            self.decoration_capacity = bytes.len() as u64;
            self.decoration_instances = Self::buffer(device, self.decoration_capacity);
        }
        queue.write_buffer(&self.decoration_instances, 0, bytes);
        if let Some(basis) = basis.filter(|_| reused_camera.is_none()) {
            let points: Vec<Mark> = scene.points.iter().map(|point| Mark {
                position: basis.position(point), size: [0.0; 2], color: BLUE, kind_glyph: [1.0, 0.0],
            }).collect();
            let bytes = bytemuck::cast_slice(&points);
            if bytes.len() as u64 > self.capacity {
                self.capacity = bytes.len() as u64;
                self.instances = Self::buffer(device, self.capacity);
            }
            if !bytes.is_empty() {
                queue.write_buffer(&self.instances, 0, bytes);
                self.uploads += 1;
            }
            self.point_basis = Some(basis);
            self.content_hash = Some(content_hash);
        } else {
            self.hits += 1;
        }
        queue.write_buffer(
            &self.uniform,
            0,
            bytemuck::cast_slice(&[
                plot[0],
                plot[1],
                plot[2],
                plot[3],
                width as f32,
                height as f32,
                ratio,
                0.0,
                camera[0],
                camera[1],
                camera[2],
                camera[3],
            ]),
        );
        Ok(())
    }

    pub(crate) fn cache_stats(&self) -> GraphNewGpuCacheStats {
        GraphNewGpuCacheStats { allocated_bytes: self.capacity + self.decoration_capacity + 48 + u64::from(ATLAS_WIDTH) * u64::from(ATLAS_HEIGHT),
            geometry_capacity_bytes: self.capacity + self.decoration_capacity, geometry_uploads: self.uploads, geometry_hits: self.hits }
    }

    pub(crate) fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bindings, &[]);
        pass.set_vertex_buffer(0, self.decoration_instances.slice(..));
        pass.draw(0..6, 0..self.decorations);
        pass.set_scissor_rect(self.plot[0], self.plot[1], self.plot[2], self.plot[3]);
        pass.set_vertex_buffer(0, self.instances.slice(..));
        pass.draw(0..6, 0..self.total);
    }
}

fn axis_labels(scene: &GraphNewScene, horizontal: bool) -> Result<Vec<(String, [f32; 2])>, AppError> {
    let (width, height) = scene.physical_size()?;
    let plot = scene.plot();
    let ratio = scene.device_pixel_ratio as f32;
    let scale = (2.0 * ratio).max(1.0);
    let text_height = 5.0 * scale;
    let mut ticks = if horizontal {
        numeric_ticks(scene.domain.x_min, scene.domain.x_max)?
    } else {
        numeric_ticks(scene.domain.y_min, scene.domain.y_max)?
    };
    if !horizontal { ticks.reverse(); }
    let mut labels = Vec::new();
    let mut previous_end = f32::NEG_INFINITY;
    for tick in ticks {
        let text_width = tick.label.len() as f32 * 4.0 * scale;
        if text_width > if horizontal { width as f32 } else { 56.0 * ratio } {
            continue;
        }
        let position = if horizontal {
            [
                (plot[0] + tick.position as f32 * plot[2] - text_width / 2.0)
                    .clamp(0.0, width as f32 - text_width),
                plot[1] + plot[3] + 8.0 * ratio,
            ]
        } else {
            [
                plot[0] - 4.0 * ratio - text_width,
                plot[1] + (1.0 - tick.position as f32) * plot[3] - text_height / 2.0,
            ]
        };
        let start = position[if horizontal { 0 } else { 1 }];
        if start < previous_end + 4.0 * ratio || position[0] < 0.0 || position[1] < 0.0
            || position[1] + text_height > height as f32 {
            continue;
        }
        previous_end = start + if horizontal { text_width } else { text_height };
        labels.push((tick.label, position));
    }
    Ok(labels)
}

fn rect(position: [f32; 2], size: [f32; 2], color: [f32; 4]) -> Mark {
    Mark {
        position,
        size,
        color,
        kind_glyph: [0.0; 2],
    }
}

fn text(marks: &mut Vec<Mark>, label: &str, position: [f32; 2], scale: f32) {
    for (index, glyph) in label.chars().take(24).enumerate() {
        if let Some(slot) = glyph_index(glyph) {
            marks.push(Mark {
                position: [position[0] + index as f32 * 4.0 * scale, position[1]],
                size: [3.0 * scale, 5.0 * scale],
                color: INK,
                kind_glyph: [2.0, slot as f32],
            });
        }
    }
}

const SHADER: &str = r#"
struct Camera { plot: vec4<f32>, viewport: vec4<f32>, affine: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var atlas: texture_2d<f32>;
struct Output {
    @builtin(position) position: vec4<f32>,
    @location(0) local: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) @interpolate(flat) kind_glyph: vec2<f32>,
};
@vertex fn vs_main(@builtin(vertex_index) index: u32,
    @location(0) position: vec2<f32>, @location(1) size: vec2<f32>,
    @location(2) color: vec4<f32>, @location(3) kind_glyph: vec2<f32>) -> Output {
    let corners = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(1.,1.), vec2(0.,0.), vec2(1.,1.), vec2(0.,1.));
    let local = corners[index];
    var pixel = position + local * size;
    if kind_glyph.x == 1.0 {
        let projected = clamp(position * camera.affine.xy + camera.affine.zw, vec2(-1.0), vec2(2.0));
        pixel = camera.plot.xy + vec2(projected.x, 1.0 - projected.y) * camera.plot.zw
            + (local * 2.0 - 1.0) * 3.0 * camera.viewport.z;
    }
    var output: Output;
    output.position = vec4(pixel.x / camera.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / camera.viewport.y * 2.0, 0.0, 1.0);
    output.local = local;
    output.color = color;
    output.kind_glyph = kind_glyph;
    return output;
}
@fragment fn fs_main(input: Output) -> @location(0) vec4<f32> {
    if input.kind_glyph.x == 1.0 && length(input.local * 2.0 - 1.0) > 1.0 { discard; }
    if input.kind_glyph.x == 2.0 {
        let cell = vec2<i32>(min(input.local * vec2(3.0, 5.0), vec2(2.0, 4.0)));
        if textureLoad(atlas, vec2(i32(input.kind_glyph.y) * 4 + cell.x, cell.y), 0).r < 0.5 { discard; }
    }
    return input.color;
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn scene() -> GraphNewScene {
        GraphNewScene {
            width: 240,
            height: 160,
            device_pixel_ratio: 1.0,
            domain: GraphDomain {
                x_min: 0.0,
                x_max: 1.0,
                y_min: 0.0,
                y_max: 1.0,
            },
            points: vec![],
        }
    }

    #[test]
    fn rejects_invalid_inputs_before_gpu_allocation() {
        for (width, height, dpr) in [
            (0, 160, 1.0),
            (240, 0, 1.0),
            (1, 1, 1.0),
            (u32::MAX, 160, 1.0),
            (240, 160, 0.0),
            (240, 160, -1.0),
            (240, 160, f64::NAN),
            (240, 160, f64::INFINITY),
            (240, 160, 9.0),
            (3840, 2160, 2.0),
        ] {
            let mut input = scene();
            input.width = width;
            input.height = height;
            input.device_pixel_ratio = dpr;
            assert!(matches!(
                GraphNewRenderer::render(&input),
                Err(AppError::InvalidParam(_))
            ));
        }
        let mut input = scene();
        input.domain.x_min = f64::NAN;
        assert!(GraphNewRenderer::render(&input).is_err());
        input = scene();
        input.domain.y_max = -1.0;
        assert!(GraphNewRenderer::render(&input).is_err());
        input = scene();
        input.points.push(SourcePoint::new(1, f64::INFINITY, 0.0));
        assert!(GraphNewRenderer::render(&input).is_err());
        input.points = vec![SourcePoint::new(1, 0.5, 0.5); MAX_SCENE_POINTS + 1];
        assert!(GraphNewRenderer::render(&input).is_err());
    }

    fn pixel(frame: &SyntheticFrame, width: usize, horizontal: usize, vertical: usize) -> &[u8] {
        let offset = (vertical * width + horizontal) * 4;
        &frame.rgba[offset..offset + 4]
    }

    #[test]
    fn camera_pan_zoom_moves_native_pixels_without_point_uploads() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let mut input = scene();
        input.points = vec![SourcePoint::new(1, 0.3, 0.7)];
        let first = pollster::block_on(renderer.render_scene(&input)).expect("initial");
        assert_eq!(pixel(&first, 240, 112, 49), [31, 111, 235, 255]);
        let uploads = renderer.cache_stats().geometry_uploads;
        input.domain.x_min = -0.2;
        input.domain.x_max = 0.8;
        let panned = pollster::block_on(renderer.render_scene(&input)).expect("pan");
        assert_eq!(pixel(&panned, 240, 144, 49), [31, 111, 235, 255]);
        assert_ne!(pixel(&panned, 240, 112, 49), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads, "pan must reuse points");
        input.domain.x_min = 0.2;
        input.domain.x_max = 0.7;
        input.domain.y_min = 0.5;
        input.domain.y_max = 1.0;
        let zoomed = pollster::block_on(renderer.render_scene(&input)).expect("zoom");
        assert_eq!(pixel(&zoomed, 240, 96, 83), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads, "zoom must reuse points");
    }

    #[test]
    fn camera_empty_pointsets_do_not_count_decoration_uploads() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let mut input = scene();
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(renderer.cache_stats().geometry_uploads, 0);
        input.points.push(SourcePoint::new(1, 0.3, 0.7));
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(renderer.cache_stats().geometry_uploads, 1);
        input.points.clear();
        let empty = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert!(!empty.rgba.chunks_exact(4).any(|value| value == [31, 111, 235, 255]));
        assert_eq!(renderer.cache_stats().geometry_uploads, 1);
        input.domain.x_max = 2.0;
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(renderer.cache_stats().geometry_uploads, 1);
    }

    #[test]
    fn camera_resize_dpr_and_offscreen_reentry_reuse_point_buffer() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let mut input = scene();
        input.points = vec![SourcePoint::new(1, 0.3, 0.7), SourcePoint::new(2, 10.3, 0.7)];
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        let uploads = renderer.cache_stats().geometry_uploads;
        input.domain.x_min = 10.0;
        input.domain.x_max = 11.0;
        let panned = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&panned, 240, 112, 49), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads);
        input.width = 400;
        input.height = 240;
        input.device_pixel_ratio = 2.0;
        let resized = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&resized, 800, 320, 147), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads);
        input.domain.x_min = 0.0;
        input.domain.x_max = 1.0;
        let returned = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&returned, 800, 320, 147), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads);
        input.points[0].x = 0.5;
        let changed = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&changed, 800, 448, 147), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 1);
        input.points[0].row_id = 9;
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 2);
        input.points.pop();
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 3);
        let stats = renderer.cache_stats();
        assert!(stats.geometry_capacity_bytes >= 2 * std::mem::size_of::<Mark>() as u64);
        assert_eq!(stats.allocated_bytes, stats.geometry_capacity_bytes + 48
            + u64::from(ATLAS_WIDTH) * u64::from(ATLAS_HEIGHT) + 800 * 480 * 4 + 3328 * 480);
    }

    #[test]
    fn camera_deep_zoom_rebases_and_preserves_offscreen_points() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let mut input = scene();
        input.points = vec![SourcePoint::new(1, 0.0, 0.7), SourcePoint::new(2, 1.0, 0.7),
            SourcePoint::new(3, 0.5 + 3e-10, 0.7)];
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        let uploads = renderer.cache_stats().geometry_uploads;
        input.domain.x_min = 0.5;
        input.domain.x_max = 0.5 + 1e-9;
        assert!(PointBasis::reference(&input).camera(&input).is_none());
        let zoomed = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&zoomed, 240, 112, 49), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 1);
        let repeated = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(zoomed.rgba, repeated.rgba);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 1);
        input.domain.x_min = 0.7;
        input.domain.x_max = 1.7;
        let reentered = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&reentered, 240, 112, 49), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 2);
        input.domain.x_min = 0.8;
        input.domain.x_max = 1.8;
        let reused = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&reused, 240, 96, 49), [31, 111, 235, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 2);
    }

    #[test]
    fn camera_extreme_domains_rebase_to_f64_reference_pixels() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let adjacent = f64::from_bits(1e300_f64.to_bits() + 1);
        for (minimum, maximum, value) in [
            (7.0, 7.0, 7.0),
            (0.0, f64::from_bits(4), f64::from_bits(2)),
            (-f64::MAX, f64::MAX, 0.0),
            (1e-200, 3e-200, 2e-200),
            (1e300, adjacent, 1e300),
            (1e300, adjacent, adjacent),
        ] {
            let mut input = scene();
            input.domain = GraphDomain { x_min: -f64::MAX, x_max: f64::MAX,
                y_min: -f64::MAX, y_max: f64::MAX };
            input.points = vec![SourcePoint::new(1, -f64::MAX, -f64::MAX),
                SourcePoint::new(2, f64::MAX, f64::MAX), SourcePoint::new(3, value, value)];
            pollster::block_on(renderer.render_scene(&input)).unwrap();
            input.domain = GraphDomain { x_min: minimum, x_max: maximum, y_min: minimum, y_max: maximum };
            let frame = pollster::block_on(renderer.render_scene(&input)).unwrap();
            let position = normalized(value, minimum, maximum);
            let horizontal = (64.0 + position * 160.0).floor().clamp(64.0, 223.0) as usize;
            let vertical = (16.0 + (1.0 - position) * 112.0).floor().clamp(16.0, 127.0) as usize;
            assert_eq!(pixel(&frame, 240, horizontal, vertical), [31, 111, 235, 255],
                "domain {minimum}..{maximum}, value {value}");
            let uploads = renderer.cache_stats().geometry_uploads;
            let repeated = pollster::block_on(renderer.render_scene(&input)).unwrap();
            assert_eq!(frame.rgba, repeated.rgba);
            assert_eq!(renderer.cache_stats().geometry_uploads, uploads);
        }
        assert!(check_gpu_budget(u64::MAX, 1, u64::MAX).is_err());
    }

    #[test]
    fn graph_new_cache_gpu_reuses_geometry_and_accounts_allocations() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let mut input = scene();
        input.points = vec![SourcePoint::new(1, 0.3, 0.7)];
        let first = pollster::block_on(renderer.render_scene(&input)).expect("first");
        let before = renderer.cache_stats();
        let second = pollster::block_on(renderer.render_scene(&input)).expect("reuse");
        let after = renderer.cache_stats();
        assert_eq!(first.rgba, second.rgba);
        assert_eq!(after.geometry_uploads, before.geometry_uploads);
        assert_eq!(after.geometry_hits, before.geometry_hits + 1);
        assert_eq!(after.allocated_bytes, before.allocated_bytes);
        assert!(after.allocated_bytes >= 240 * 160 * 4 * 2);
        input.points[0].x = 0.8;
        let changed = pollster::block_on(renderer.render_scene(&input)).expect("changed");
        assert_ne!(changed.rgba, first.rgba);
        assert_eq!(renderer.cache_stats().geometry_uploads, after.geometry_uploads + 1);
        assert!(renderer.cache_stats().allocated_bytes <= super::super::graph_new_cache::DEFAULT_GPU_BYTES);
        assert!(check_gpu_budget(100, 50, 149).is_err());
        assert!(check_gpu_budget(100, 50, 150).is_ok());
    }

    #[test]
    fn gpu_circles_transform_clip_and_scale_at_both_dprs() {
        for ratio in [1, 2] {
            let mut input = scene();
            input.device_pixel_ratio = ratio as f64;
            let empty = GraphNewRenderer::render(&input).expect("empty axes frame");
            input.points = vec![
                SourcePoint::new(1, 0.3, 0.7),
                SourcePoint::new(2, 0.0, 0.5),
                SourcePoint::new(3, 1.0, 0.5),
                SourcePoint::new(4, 0.5, 0.0),
                SourcePoint::new(5, 0.5, 1.0),
                SourcePoint::new(6, -0.01, 0.25),
            ];
            let frame = GraphNewRenderer::render(&input).expect("GPU point frame");
            let width = 240 * ratio;
            assert_eq!(frame.rgba.len(), width * 160 * ratio * 4);
            assert_eq!(
                pixel(&frame, width, 112 * ratio, 49 * ratio),
                [31, 111, 235, 255]
            );
            assert_ne!(
                pixel(&frame, width, 114 * ratio, 47 * ratio),
                [31, 111, 235, 255]
            );
            assert_eq!(
                pixel(&frame, width, 5 * ratio, 5 * ratio),
                [255, 255, 255, 255]
            );
            assert!(empty
                .rgba
                .chunks_exact(4)
                .any(|value| value == [226, 232, 240, 255]));
            assert!(empty
                .rgba
                .chunks_exact(4)
                .any(|value| value == [71, 85, 105, 255]));
            assert_eq!(
                pixel(&empty, width, 62 * ratio, 136 * ratio),
                [71, 85, 105, 255]
            );
            for vertical in 0..160 * ratio {
                for horizontal in 0..width {
                    if horizontal < 64 * ratio
                        || horizontal >= 224 * ratio
                        || vertical < 16 * ratio
                        || vertical >= 128 * ratio
                    {
                        assert_eq!(
                            pixel(&frame, width, horizontal, vertical),
                            pixel(&empty, width, horizontal, vertical)
                        );
                    }
                }
            }
            assert!(frame.render_ms.is_finite() && frame.render_ms >= 0.0);
            assert!(frame.readback_ms.is_finite() && frame.readback_ms >= 0.0);
        }
    }

    #[test]
    fn labels_are_bounded_distinct_and_spaced_at_minimum_and_normal_sizes() {
        for (width, height) in [(96, 64), (240, 160)] {
            for ratio in [0.5, 1.0, 2.0] {
                for (minimum, maximum) in [(1.0001, 1.0009), (1e-200, 3e-200),
                    (-f64::MAX, f64::MAX), (1.0, f64::from_bits(1.0f64.to_bits() + 1)),
                    (0.0, f64::from_bits(4))] {
                    let mut input = scene();
                    input.width = width;
                    input.height = height;
                    input.device_pixel_ratio = ratio;
                    input.domain = GraphDomain { x_min: minimum, x_max: maximum, y_min: minimum, y_max: maximum };
                    let scale = (2.0 * ratio as f32).max(1.0);
                    for horizontal in [true, false] {
                        let labels = axis_labels(&input, horizontal).unwrap();
                        for (label, position) in &labels {
                            assert!(position[0] >= 0.0 && position[1] >= 0.0);
                            assert!(position[0] + label.len() as f32 * 4.0 * scale <= (width as f64 * ratio).ceil() as f32);
                            assert!(position[1] + 5.0 * scale <= (height as f64 * ratio).ceil() as f32);
                            assert!(5.0 * scale / ratio as f32 >= 8.0);
                        }
                        for pair in labels.windows(2) {
                            assert_ne!(pair[0].0, pair[1].0);
                            let axis = if horizontal { 0 } else { 1 };
                            let extent = if horizontal { pair[0].0.len() as f32 * 4.0 * scale } else { 5.0 * scale };
                            assert!(pair[1].1[axis] >= pair[0].1[axis] + extent + 4.0 * ratio as f32);
                        }
                        if horizontal && width == 240 { assert!(!labels.is_empty()); }
                    }
                }
            }
        }
    }

    #[test]
    fn gpu_close_decimal_labels_keep_readable_height() {
        for ratio in [0.5, 1.0, 2.0] {
            let mut input = scene();
            input.device_pixel_ratio = ratio;
            input.domain.x_min = 1.0001;
            input.domain.x_max = 1.0009;
            let frame = GraphNewRenderer::render(&input).unwrap();
            let (width, height) = input.physical_size().unwrap();
            let first_row = (input.plot()[1] + input.plot()[3] + 8.0 * ratio as f32).ceil() as usize;
            let ink_rows = (first_row..height as usize).filter(|&vertical| {
                (0..width as usize).any(|horizontal| pixel(&frame, width as usize, horizontal, vertical) == [71, 85, 105, 255])
            }).count();
            assert!(ink_rows >= (8.0 * ratio).ceil() as usize, "DPR {ratio}: {ink_rows} ink rows");
        }
    }

    #[test]
    fn gpu_extreme_domains_keep_midpoint_visible() {
        for (minimum, maximum, midpoint) in [
            (7.0, 7.0, 7.0),
            (0.0, f64::from_bits(4), f64::from_bits(2)),
            (-f64::MAX, f64::MAX, 0.0),
            (1e-200, 3e-200, 2e-200),
        ] {
            let mut input = scene();
            input.domain = GraphDomain {
                x_min: minimum,
                x_max: maximum,
                y_min: minimum,
                y_max: maximum,
            };
            input.points.push(SourcePoint::new(1, midpoint, midpoint));
            let frame = GraphNewRenderer::render(&input).expect("extreme domain frame");
            assert_eq!(pixel(&frame, 240, 144, 72), [31, 111, 235, 255]);
        }
    }
}
