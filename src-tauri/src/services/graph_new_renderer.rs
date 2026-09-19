use super::graph_new_lod::{GraphDomain, SourcePoint};
use super::graph_new_overlay::{
    EnabledOverlayMask, GroupedLineSegment, GroupedMeanPoint, OverlayCatalog,
};
use super::graph_new_text::{glyph_index, numeric_atlas, ATLAS_HEIGHT, ATLAS_WIDTH};
use super::graph_new_ticks::{normalized, numeric_ticks, validate_domain};
use super::graph_new_transport_service::{
    session_renderer, SyntheticFrame, SyntheticFrameRenderer,
};
use crate::error::AppError;
use sha2::{Digest, Sha256};
use crate::models::graph_new::GraphNewGpuCacheStats;
use std::sync::{Arc, Weak};

pub(crate) const MAX_SCENE_POINTS: usize = 2_100_000;
const GRID: [f32; 4] = [226.0 / 255.0, 232.0 / 255.0, 240.0 / 255.0, 1.0];
const INK: [f32; 4] = [71.0 / 255.0, 85.0 / 255.0, 105.0 / 255.0, 1.0];
const BLUE: [f32; 4] = [31.0 / 255.0, 111.0 / 255.0, 235.0 / 255.0, 1.0];
const RED: [f32; 4] = [220.0 / 255.0, 38.0 / 255.0, 38.0 / 255.0, 1.0];

/// Logical dimensions; output is ceil(width * DPR) by ceil(height * DPR) RGBA8.
#[derive(Clone)]
pub(crate) struct GraphNewScene {
    pub(crate) presentation: ScenePresentation,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) device_pixel_ratio: f64,
    pub(crate) domain: GraphDomain,
    pub(crate) points: Vec<SourcePoint>,
    pub(crate) overlay: OverlayCatalog,
    pub(crate) enabled_groups: EnabledOverlayMask,
    pub(crate) mean: Option<Arc<Vec<GroupedMeanPoint>>>,
}

#[derive(Clone)]
pub(crate) struct ScenePresentation {
    pub(crate) raw_line: Option<Arc<Vec<GroupedLineSegment>>>,
    pub(crate) show_points: bool,
    pub(crate) x_axis: Option<crate::models::graph_new::GraphNewAxis>,
}

impl Default for ScenePresentation {
    fn default() -> Self { Self { raw_line: None, show_points: true, x_axis: None } }
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
        if self.presentation.raw_line.as_ref().is_some_and(|segments| {
            segments.len() > MAX_SCENE_POINTS
                || segments
                    .iter()
                    .flat_map(|segment| segment.indices)
                    .any(|index| index as usize >= self.points.len())
        }) {
            return Err(AppError::InvalidParam("graph-new invalid raw line indices".into()));
        }
        if self.points.len() > MAX_SCENE_POINTS
            || self.mean.as_ref().is_some_and(|mean| mean.len() > MAX_SCENE_POINTS)
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

    pub(crate) fn raw_upload_bytes(&self) -> u64 {
        self.presentation.raw_line.as_ref().map_or(if self.overlay.active { 12 } else { 8 }, |segments| {
            let enabled = segments
                .iter()
                .filter(|segment| self.enabled_groups.is_enabled(segment.group_code))
                .count()
                .max(1) as u64;
            if self.overlay.active {
                enabled * 24
            } else if PointBasis::reference(self).camera(self).is_none() {
                enabled * 16
            } else {
                enabled * 8
            }
        })
    }

    pub(crate) fn enabled_point_count(&self) -> usize {
        self.points
            .iter()
            .filter(|point| self.enabled_groups.is_enabled(point.group_code))
            .count()
    }

    pub(crate) fn point_upload_bytes(&self) -> u64 {
        if self.presentation.show_points {
            self.enabled_point_count().max(1) as u64 * 40
        } else {
            0
        }
    }

    fn point_color_bytes(&self, group_code: u16) -> [u8; 4] {
        self.overlay.rgba_bytes(group_code).unwrap_or([31, 111, 235, 255])
    }

    fn raw_color_bytes(&self, group_code: u16) -> [u8; 4] {
        self.overlay.rgba_bytes(group_code).unwrap_or([31, 111, 235, 255])
    }

    fn mean_color_bytes(&self, group_code: u16) -> [u8; 4] {
        self.overlay.rgba_bytes(group_code).unwrap_or([220, 38, 38, 255])
    }

    fn point_color(&self, group_code: u16) -> [f32; 4] {
        let [r, g, b, a] = self.point_color_bytes(group_code);
        [
            f32::from(r) / 255.0,
            f32::from(g) / 255.0,
            f32::from(b) / 255.0,
            f32::from(a) / 255.0,
        ]
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

    #[cfg(any(test, feature = "perf-harness"))]
    pub(crate) fn render(scene: &GraphNewScene) -> Result<SyntheticFrame, AppError> {
        Self::render_current(scene, || true)
    }

    pub(crate) fn render_current(scene: &GraphNewScene, current: impl FnMut() -> bool) -> Result<SyntheticFrame, AppError> {
        scene.physical_size()?;
        let mut guard = session_renderer()
            .lock()
            .map_err(|_| AppError::Stats("graph-new renderer lock poisoned".into()))?;
        super::graph_new_transport_service::recover_renderer(&mut guard, &mut false,
            || pollster::block_on(SyntheticFrameRenderer::new()),
            |renderer| pollster::block_on(renderer.render_scene(scene)), current)
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

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct ColoredVertex {
    position: [f32; 2],
    color: [u8; 4],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct MeanSegment {
    start: [f32; 2],
    end: [f32; 2],
    color: [u8; 4],
    _padding: [u8; 4],
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
        [normalized(point.x, self.domain.x_min, self.domain.x_max) as f32,
            normalized(point.y, self.domain.y_min, self.domain.y_max) as f32]
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
    raw_pipeline: wgpu::RenderPipeline,
    raw_clipped_pipeline: wgpu::RenderPipeline,
    grouped_raw_pipeline: wgpu::RenderPipeline,
    raw_vertices: wgpu::Buffer,
    raw_capacity: u64,
    raw_source: Weak<Vec<GroupedLineSegment>>,
    raw_mask: Option<u64>,
    raw_basis: Option<PointBasis>,
    raw_grouped: bool,
    raw_count: u32,
    pipeline: wgpu::RenderPipeline,
    mean_pipeline: wgpu::RenderPipeline,
    mean_instances: wgpu::Buffer,
    mean_capacity: u64,
    mean_source: Weak<Vec<GroupedMeanPoint>>,
    mean_basis: Option<PointBasis>,
    mean_mask: Option<u64>,
    mean_segments: u32,
    mean_uploads: u64,
    mean_hits: u64,
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
            size: 64,
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
        let [raw_pipeline, raw_clipped_pipeline] = [std::mem::size_of::<Mark>() as u64, 8]
            .map(|stride| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("graph-new indexed raw line"), layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_indexed_raw"), compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: stride, step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2] })] },
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::LineList, ..Default::default() },
            depth_stencil: None, multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_main"), compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })] }),
            multiview_mask: None, cache: None,
        }));
        let grouped_raw_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("graph-new grouped raw line"), layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_raw"), compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<ColoredVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Unorm8x4] })] },
            primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::LineList, ..Default::default() },
            depth_stencil: None, multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_main"), compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })] }),
            multiview_mask: None, cache: None,
        });
        let mean_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("graph-new mean pipeline"), layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_mean"), compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout { array_stride: std::mem::size_of::<MeanSegment>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Unorm8x4] })] },
            primitive: Default::default(), depth_stencil: None, multisample: Default::default(),
            fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_main"), compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })] }),
            multiview_mask: None, cache: None,
        });
        Self {
            pipeline,
            raw_pipeline,
            raw_clipped_pipeline,
            grouped_raw_pipeline,
            raw_vertices: Self::raw_buffer(device, 12),
            raw_capacity: 12,
            raw_source: Weak::new(),
            raw_mask: None,
            raw_basis: None,
            raw_grouped: false,
            raw_count: 0,
            mean_pipeline,
            mean_instances: Self::buffer(device, 24),
            mean_capacity: 24,
            mean_source: Weak::new(),
            mean_basis: None,
            mean_mask: None,
            mean_segments: 0,
            mean_uploads: 0,
            mean_hits: 0,
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

    fn raw_buffer(device: &wgpu::Device, size: u64) -> wgpu::Buffer {
        device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("graph-new raw geometry"),
            size,
            usage: wgpu::BufferUsages::VERTEX
                | wgpu::BufferUsages::INDEX
                | wgpu::BufferUsages::COPY_DST,
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
            digest.update(point.group_code.to_le_bytes());
            digest.update(scene.point_color_bytes(point.group_code));
        }
        digest.update(scene.enabled_groups.bits().to_le_bytes());
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
        let x_positions: Vec<f64> = match &scene.presentation.x_axis {
            Some(axis) => axis.ticks.iter().map(|tick| tick.position).collect(),
            None => numeric_ticks(scene.domain.x_min, scene.domain.x_max)?.into_iter().map(|tick| tick.position).collect(),
        };
        for position in x_positions {
            let horizontal = plot[0] + position as f32 * plot[2];
            marks.push(rect([horizontal, plot[1]], [ratio, plot[3]], GRID));
        }
        for tick in numeric_ticks(scene.domain.y_min, scene.domain.y_max)? {
            let vertical = plot[1] + (1.0 - tick.position as f32) * plot[3];
            marks.push(rect([plot[0], vertical], [plot[2], ratio], GRID));
        }
        for horizontal in [true, false] {
            if horizontal && scene.presentation.x_axis.is_some() { continue; }
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
        self.total = if scene.presentation.show_points {
            scene.enabled_point_count() as u32
        } else {
            0
        };
        if marks.len() > 1024 { return Err(AppError::Stats("graph_new_cache_pressure".into())); }
        self.plot = plot.map(|value| value as u32);
        let bytes = bytemuck::cast_slice(&marks);
        if bytes.len() as u64 > self.decoration_capacity {
            self.decoration_capacity = bytes.len() as u64;
            self.decoration_instances = Self::buffer(device, self.decoration_capacity);
        }
        queue.write_buffer(&self.decoration_instances, 0, bytes);
        if let Some(basis) = basis.filter(|_| reused_camera.is_none()) {
            if scene.presentation.show_points {
                let points: Vec<Mark> = scene
                    .points
                    .iter()
                    .filter(|point| scene.enabled_groups.is_enabled(point.group_code))
                    .map(|point| Mark {
                        position: basis.position(point),
                        size: [0.0; 2],
                        color: scene.point_color(point.group_code),
                        kind_glyph: [1.0, 0.0],
                    })
                    .collect();
                let bytes = bytemuck::cast_slice(&points);
                if bytes.len() as u64 > self.capacity {
                    self.capacity = bytes.len() as u64;
                    self.instances = Self::buffer(device, self.capacity);
                }
                if !bytes.is_empty() {
                    queue.write_buffer(&self.instances, 0, bytes);
                    self.uploads += 1;
                }
            }
            self.point_basis = Some(basis);
            self.content_hash = Some(content_hash);
        } else {
            self.hits += 1;
        }
        let mean_camera = self.prepare_mean(device, queue, scene)?;
        self.raw_count = 0;
        if let Some(segments) = &scene.presentation.raw_line {
            let clipped = basis.is_some_and(|basis| basis.camera_relative);
            let grouped = scene.overlay.active;
            let same =
                self.raw_grouped == grouped
                    && self.raw_mask == Some(scene.enabled_groups.bits())
                    && self
                        .raw_source
                        .upgrade()
                        .is_some_and(|source| Arc::ptr_eq(&source, segments))
                    && self.raw_basis.is_some_and(|previous| {
                        previous.camera_relative == clipped
                            && (!clipped || previous.domain == scene.domain)
                    });
            if !same {
                let raw_domain = if clipped { scene.domain } else { basis.map_or(scene.domain, |basis| basis.domain) };
                let bytes = if grouped {
                    let vertices: Vec<ColoredVertex> = segments
                        .iter()
                        .filter(|segment| scene.enabled_groups.is_enabled(segment.group_code))
                        .flat_map(|segment| {
                            let start = &scene.points[segment.indices[0] as usize];
                            let end = &scene.points[segment.indices[1] as usize];
                            let endpoints = if clipped {
                                clip_mean_segment([start.x, start.y], [end.x, end.y], scene.domain)
                                    .unwrap_or([[-10.0, -10.0]; 2])
                            } else {
                                [[start.x, start.y], [end.x, end.y]]
                            };
                            let color = scene.raw_color_bytes(segment.group_code);
                            endpoints.map(|point| ColoredVertex {
                                position: [
                                    normalized(point[0], raw_domain.x_min, raw_domain.x_max)
                                        as f32,
                                    normalized(point[1], raw_domain.y_min, raw_domain.y_max)
                                        as f32,
                                ],
                                color,
                            })
                        })
                        .collect();
                    self.raw_count = vertices.len() as u32;
                    bytemuck::cast_slice(vertices.as_slice()).to_vec()
                } else if clipped {
                    let vertices: Vec<[[f32; 2]; 2]> = segments
                        .iter()
                        .filter(|segment| scene.enabled_groups.is_enabled(segment.group_code))
                        .map(|segment| {
                            let start = &scene.points[segment.indices[0] as usize];
                            let end = &scene.points[segment.indices[1] as usize];
                            clip_mean_segment([start.x, start.y], [end.x, end.y], scene.domain)
                                .map(|endpoints| {
                                    endpoints.map(|point| {
                                        [
                                            normalized(point[0], scene.domain.x_min, scene.domain.x_max) as f32,
                                            normalized(point[1], scene.domain.y_min, scene.domain.y_max) as f32,
                                        ]
                                    })
                                })
                                .unwrap_or([[-1.0; 2]; 2])
                        })
                        .collect();
                    self.raw_count = vertices.len() as u32 * 2;
                    bytemuck::cast_slice(vertices.as_slice()).to_vec()
                } else {
                    let indices: Vec<[u32; 2]> = segments
                        .iter()
                        .filter(|segment| scene.enabled_groups.is_enabled(segment.group_code))
                        .map(|segment| segment.indices)
                        .collect();
                    self.raw_count = indices.len() as u32 * 2;
                    bytemuck::cast_slice(indices.as_slice()).to_vec()
                };
                if bytes.len() as u64 > self.raw_capacity {
                    self.raw_capacity = bytes.len() as u64;
                    self.raw_vertices = Self::raw_buffer(device, self.raw_capacity);
                }
                if !bytes.is_empty() {
                    queue.write_buffer(&self.raw_vertices, 0, &bytes);
                }
                self.raw_source = Arc::downgrade(segments);
                self.raw_mask = Some(scene.enabled_groups.bits());
                self.raw_grouped = grouped;
                self.raw_basis = Some(PointBasis {
                    domain: raw_domain,
                    camera_relative: clipped,
                });
            } else {
                let visible = segments
                    .iter()
                    .filter(|segment| scene.enabled_groups.is_enabled(segment.group_code))
                    .count() as u32;
                self.raw_count = visible * 2;
            }
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
                if scene.points.len() > 50_000 { 1.0 } else { 3.0 },
                camera[0],
                camera[1],
                camera[2],
                camera[3],
                mean_camera[0], mean_camera[1], mean_camera[2], mean_camera[3],
            ]),
        );
        Ok(())
    }

    pub(crate) fn cache_stats(&self) -> GraphNewGpuCacheStats {
        GraphNewGpuCacheStats { allocated_bytes: self.capacity + self.decoration_capacity + self.mean_capacity + self.raw_capacity + 64 + u64::from(ATLAS_WIDTH) * u64::from(ATLAS_HEIGHT),
            geometry_capacity_bytes: self.capacity + self.decoration_capacity + self.mean_capacity + self.raw_capacity,
            geometry_uploads: self.uploads, geometry_hits: self.hits,
            mean_geometry_uploads: self.mean_uploads, mean_geometry_hits: self.mean_hits }
    }

    pub(crate) fn replacement_bytes(&self, scene: &GraphNewScene) -> u64 {
        let points = scene.point_upload_bytes();
        let mean = scene
            .mean
            .as_ref()
            .map_or(24, |mean| enabled_mean_segments(scene, mean).max(1) as u64 * 24);
        let raw = scene.raw_upload_bytes();
        (if points > self.capacity { points } else { 0 })
            + (if raw > self.raw_capacity { raw } else { 0 })
            + (if mean > self.mean_capacity { mean } else { 0 })
            + (if 1024 * 40 > self.decoration_capacity { 1024 * 40 } else { 0 })
    }

    pub(crate) fn reclaim_inactive_mean(&mut self, device: &wgpu::Device) {
        if self.mean_capacity <= 24 { return; }
        self.mean_instances.destroy();
        self.mean_capacity = 24;
        self.mean_instances = Self::buffer(device, self.mean_capacity);
        self.mean_source = std::sync::Weak::new();
        self.mean_basis = None;
        self.mean_mask = None;
        self.mean_segments = 0;
    }

    pub(crate) fn reclaim_inactive_raw(&mut self, device: &wgpu::Device) {
        if self.raw_capacity <= 12 { return; }
        self.raw_vertices.destroy();
        self.raw_capacity = 12;
        self.raw_vertices = Self::raw_buffer(device, self.raw_capacity);
        self.raw_source = Weak::new();
        self.raw_mask = None;
        self.raw_basis = None;
        self.raw_grouped = false;
        self.raw_count = 0;
    }

    fn prepare_mean(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, scene: &GraphNewScene) -> Result<[f32; 4], AppError> {
        self.mean_segments = 0;
        let Some(mean) = scene.mean.as_ref().filter(|mean| mean.len() >= 2) else { return Ok([1.0, 1.0, 0.0, 0.0]); };
        let same = self.mean_mask == Some(scene.enabled_groups.bits())
            && self.mean_source.upgrade().is_some_and(|source| Arc::ptr_eq(&source, mean));
        if let Some(camera) = self.mean_basis.filter(|_| same).and_then(|basis| mean_camera(basis, scene)) {
            self.mean_segments = enabled_mean_segments(scene, mean) as u32;
            self.mean_hits += 1;
            return Ok(camera);
        }
        let Some(first) = mean
            .iter()
            .find(|point| scene.enabled_groups.is_enabled(point.group_code))
            .copied()
        else {
            self.mean_source = Arc::downgrade(mean);
            self.mean_mask = Some(scene.enabled_groups.bits());
            return Ok([1.0, 1.0, 0.0, 0.0]);
        };
        let mut domain = GraphDomain { x_min: first.x, x_max: first.x, y_min: first.y, y_max: first.y };
        for point in mean
            .iter()
            .filter(|point| scene.enabled_groups.is_enabled(point.group_code))
        {
            if [point.x, point.y].iter().any(|value| !value.is_finite()) { return Err(AppError::InvalidParam("graph-new invalid mean points".into())); }
            domain.x_min = domain.x_min.min(point.x); domain.x_max = domain.x_max.max(point.x);
            domain.y_min = domain.y_min.min(point.y); domain.y_max = domain.y_max.max(point.y);
        }
        let reference = PointBasis { domain, camera_relative: false };
        let (basis, camera) = match mean_camera(reference, scene) {
            Some(camera) => (reference, camera),
            None => (PointBasis { domain: scene.domain, camera_relative: true }, [1.0, 1.0, 0.0, 0.0]),
        };
        let segments: Vec<MeanSegment> = mean
            .windows(2)
            .filter(|pair| {
                pair[0].group_code == pair[1].group_code
                    && scene.enabled_groups.is_enabled(pair[0].group_code)
            })
            .map(|pair| {
                let endpoints = if basis.camera_relative {
                    clip_mean_segment([pair[0].x, pair[0].y], [pair[1].x, pair[1].y], basis.domain)
                        .unwrap_or([[basis.domain.x_min, basis.domain.y_min]; 2])
                } else {
                    [[pair[0].x, pair[0].y], [pair[1].x, pair[1].y]]
                };
                MeanSegment {
                    start: [
                        normalized(endpoints[0][0], basis.domain.x_min, basis.domain.x_max) as f32,
                        normalized(endpoints[0][1], basis.domain.y_min, basis.domain.y_max) as f32,
                    ],
                    end: [
                        normalized(endpoints[1][0], basis.domain.x_min, basis.domain.x_max) as f32,
                        normalized(endpoints[1][1], basis.domain.y_min, basis.domain.y_max) as f32,
                    ],
                    color: scene.mean_color_bytes(pair[0].group_code),
                    _padding: [0; 4],
                }
            })
            .collect();
        let bytes = bytemuck::cast_slice(&segments);
        if bytes.len() as u64 > self.mean_capacity {
            self.mean_capacity = bytes.len() as u64;
            self.mean_instances = Self::buffer(device, self.mean_capacity);
        }
        if !bytes.is_empty() {
            queue.write_buffer(&self.mean_instances, 0, bytes);
        }
        self.mean_segments = segments.len() as u32;
        self.mean_source = Arc::downgrade(mean);
        self.mean_basis = Some(basis);
        self.mean_mask = Some(scene.enabled_groups.bits());
        self.mean_uploads += 1;
        Ok(camera)
    }

    pub(crate) fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bindings, &[]);
        pass.set_vertex_buffer(0, self.decoration_instances.slice(..));
        pass.draw(0..6, 0..self.decorations);
        pass.set_scissor_rect(self.plot[0], self.plot[1], self.plot[2], self.plot[3]);
        pass.set_vertex_buffer(0, self.instances.slice(..));
        pass.draw(0..6, 0..self.total);
        if self.raw_count > 0 {
            if self.raw_grouped {
                pass.set_pipeline(&self.grouped_raw_pipeline);
                pass.set_vertex_buffer(0, self.raw_vertices.slice(..));
                pass.draw(0..self.raw_count, 0..1);
            } else if self.raw_basis.is_some_and(|basis| basis.camera_relative) {
                pass.set_pipeline(&self.raw_clipped_pipeline);
                pass.set_vertex_buffer(0, self.raw_vertices.slice(..));
                pass.draw(0..self.raw_count, 0..1);
            } else {
                pass.set_pipeline(&self.raw_pipeline);
                pass.set_vertex_buffer(0, self.instances.slice(..));
                pass.set_index_buffer(self.raw_vertices.slice(..), wgpu::IndexFormat::Uint32);
                pass.draw_indexed(0..self.raw_count, 0, 0..1);
            }
        }
        pass.set_pipeline(&self.mean_pipeline);
        pass.set_vertex_buffer(0, self.mean_instances.slice(..));
        pass.draw(0..6, 0..self.mean_segments);
    }
}

fn mean_camera(basis: PointBasis, scene: &GraphNewScene) -> Option<[f32; 4]> {
    if basis.camera_relative {
        return (basis.domain == scene.domain).then_some([1.0, 1.0, 0.0, 0.0]);
    }
    let mut affine = [0.0f32; 4];
    for (axis, min, max, camera_min, camera_max) in [
        (0, basis.domain.x_min, basis.domain.x_max, scene.domain.x_min, scene.domain.x_max),
        (1, basis.domain.y_min, basis.domain.y_max, scene.domain.y_min, scene.domain.y_max),
    ] {
        let offset = normalized(min, camera_min, camera_max);
        let scale = if min == max { 0.0 } else { normalized(max, camera_min, camera_max) - offset };
        affine[axis] = scale as f32; affine[axis + 2] = offset as f32;
        let error = 8.0 * f64::from(f32::EPSILON) * (scale.abs() + offset.abs() + 1.0);
        if !error.is_finite() || error * f64::from(scene.plot()[axis + 2]) > 0.125 { return None; }
    }
    affine.iter().all(|value| value.is_finite()).then_some(affine)
}

fn enabled_mean_segments(scene: &GraphNewScene, mean: &[GroupedMeanPoint]) -> usize {
    mean.windows(2)
        .filter(|pair| {
            pair[0].group_code == pair[1].group_code
                && scene.enabled_groups.is_enabled(pair[0].group_code)
        })
        .count()
}

fn clip_mean_segment(mut start: [f64; 2], mut end: [f64; 2], domain: GraphDomain) -> Option<[[f64; 2]; 2]> {
    for (axis, boundary, lower) in [(0, domain.x_min, true), (0, domain.x_max, false),
        (1, domain.y_min, true), (1, domain.y_max, false)] {
        let start_out = if lower { start[axis] < boundary } else { start[axis] > boundary };
        let end_out = if lower { end[axis] < boundary } else { end[axis] > boundary };
        if start_out && end_out { return None; }
        if start_out != end_out {
            let fraction = normalized(boundary, start[axis], end[axis]);
            let other = 1 - axis;
            let span = end[other] - start[other];
            let value = if span.is_finite() { start[other] + span * fraction }
                else { start[other] * (1.0 - fraction) + end[other] * fraction };
            let endpoint = if start_out { &mut start } else { &mut end };
            endpoint[axis] = boundary; endpoint[other] = value;
        }
    }
    Some([start, end])
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
struct Camera { plot: vec4<f32>, viewport: vec4<f32>, affine: vec4<f32>, mean_affine: vec4<f32> };
@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var atlas: texture_2d<f32>;
struct Output {
    @builtin(position) position: vec4<f32>,
    @location(0) local: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) @interpolate(flat) kind_glyph: vec2<f32>,
};
@vertex fn vs_indexed_raw(@location(0) position: vec2<f32>) -> Output {
    let projected = position * camera.affine.xy + camera.affine.zw;
    let pixel = camera.plot.xy + vec2(projected.x, 1.0 - projected.y) * camera.plot.zw;
    var output: Output;
    output.position = vec4(pixel.x / camera.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / camera.viewport.y * 2.0, 0.0, 1.0);
    output.local = vec2(0.0); output.color = vec4(31.0 / 255.0, 111.0 / 255.0, 235.0 / 255.0, 1.0);
    output.kind_glyph = vec2(3.0, 0.0); return output;
}
@vertex fn vs_raw(@location(0) position: vec2<f32>, @location(1) color: vec4<f32>) -> Output {
    let projected = position * camera.affine.xy + camera.affine.zw;
    let pixel = camera.plot.xy + vec2(projected.x, 1.0 - projected.y) * camera.plot.zw;
    var output: Output;
    output.position = vec4(pixel.x / camera.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / camera.viewport.y * 2.0, 0.0, 1.0);
    output.local = vec2(0.0); output.color = color;
    output.kind_glyph = vec2(3.0, 0.0); return output;
}
@vertex fn vs_main(@builtin(vertex_index) index: u32,
    @location(0) position: vec2<f32>, @location(1) size: vec2<f32>,
    @location(2) color: vec4<f32>, @location(3) kind_glyph: vec2<f32>) -> Output {
    let corners = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(1.,1.), vec2(0.,0.), vec2(1.,1.), vec2(0.,1.));
    let local = corners[index];
    var pixel = position + local * size;
    if kind_glyph.x == 1.0 {
        let projected = clamp(position * camera.affine.xy + camera.affine.zw, vec2(-1.0), vec2(2.0));
        pixel = camera.plot.xy + vec2(projected.x, 1.0 - projected.y) * camera.plot.zw
            + (local * 2.0 - 1.0) * camera.viewport.w * camera.viewport.z;
    }
    var output: Output;
    output.position = vec4(pixel.x / camera.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / camera.viewport.y * 2.0, 0.0, 1.0);
    output.local = local;
    output.color = color;
    output.kind_glyph = kind_glyph;
    return output;
}
@vertex fn vs_mean(@builtin(vertex_index) index: u32,
    @location(0) start: vec2<f32>, @location(1) end: vec2<f32>, @location(2) color: vec4<f32>) -> Output {
    var first = start * camera.mean_affine.xy + camera.mean_affine.zw;
    var last = end * camera.mean_affine.xy + camera.mean_affine.zw;
    var visible = true;
    for (var edge = 0u; edge < 4u; edge++) {
        let axis = edge / 2u;
        let lower = edge % 2u == 0u;
        let boundary = select(1.0, 0.0, lower);
        let first_out = select(first[axis] > boundary, first[axis] < boundary, lower);
        let last_out = select(last[axis] > boundary, last[axis] < boundary, lower);
        if first_out && last_out { visible = false; }
        if first_out != last_out {
            let fraction = (boundary - first[axis]) / (last[axis] - first[axis]);
            var clipped = mix(first, last, fraction);
            clipped[axis] = boundary;
            if first_out { first = clipped; } else { last = clipped; }
        }
    }
    first = camera.plot.xy + vec2(first.x, 1.0 - first.y) * camera.plot.zw;
    last = camera.plot.xy + vec2(last.x, 1.0 - last.y) * camera.plot.zw;
    let delta = last - first;
    let distance = length(delta);
    let normal = vec2(-delta.y, delta.x) / max(distance, 0.0001) * camera.viewport.z;
    let corners = array<vec2<f32>, 6>(vec2(0.,-1.), vec2(1.,-1.), vec2(1.,1.), vec2(0.,-1.), vec2(1.,1.), vec2(0.,1.));
    var pixel = mix(first, last, corners[index].x) + normal * corners[index].y;
    if !visible || distance < 0.0001 { pixel = vec2(-10.0); }
    var output: Output;
    output.position = vec4(pixel.x / camera.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / camera.viewport.y * 2.0, 0.0, 1.0);
    output.local = vec2(0.0);
    output.color = color;
    output.kind_glyph = vec2(3.0, 0.0);
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
    use crate::models::graph_new::GraphNewOverlayGroup;
    use crate::services::graph_new_overlay::{
        EnabledOverlayMask, GroupedLineSegment, GroupedMeanPoint, OverlayCatalog,
    };

    fn scene() -> GraphNewScene {
        GraphNewScene {
            presentation: Default::default(),
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
            overlay: OverlayCatalog::default(),
            enabled_groups: EnabledOverlayMask::from_hidden(&OverlayCatalog::default(), &[])
                .expect("all rows enabled"),
            mean: None,
        }
    }

    fn frame_contains_rgba(rgba: &[u8], needle: [u8; 4]) -> bool {
        rgba.chunks_exact(4).any(|chunk| chunk == needle)
    }

    #[test]
    fn graph_new_raw_upload_bytes_preserve_no_overlay_compaction() {
        let mut input = scene();
        input.points = vec![
            SourcePoint::new(1, 0.0, 0.0),
            SourcePoint::new(2, 0.5, 0.5),
            SourcePoint::new(3, 1.0, 1.0),
        ];
        input.presentation.raw_line = Some(std::sync::Arc::new(vec![
            GroupedLineSegment {
                indices: [0, 1],
                group_code: 0,
            },
            GroupedLineSegment {
                indices: [1, 2],
                group_code: 0,
            },
        ]));

        assert_eq!(input.raw_upload_bytes(), 16);

        input.overlay = OverlayCatalog {
            active: true,
            groups: vec![GraphNewOverlayGroup {
                id: "all".into(),
                code: 0,
                label: "All Rows".into(),
                color: [31, 111, 235, 255],
                total_rows: 3,
                missing: false,
            }],
        };
        input.enabled_groups =
            EnabledOverlayMask::from_hidden(&input.overlay, &[]).expect("overlay enabled");
        assert_eq!(input.raw_upload_bytes(), 48);
    }

    fn overlay_scene() -> GraphNewScene {
        let overlay = OverlayCatalog {
            active: true,
            groups: vec![
                GraphNewOverlayGroup {
                    id: "red".into(),
                    code: 1,
                    label: "Red".into(),
                    color: [220, 38, 38, 255],
                    total_rows: 3,
                    missing: false,
                },
                GraphNewOverlayGroup {
                    id: "blue".into(),
                    code: 2,
                    label: "Blue".into(),
                    color: [37, 99, 235, 255],
                    total_rows: 2,
                    missing: false,
                },
            ],
        };
        let enabled_groups =
            EnabledOverlayMask::from_hidden(&overlay, &["blue".to_string()]).expect("enabled");
        GraphNewScene {
            presentation: ScenePresentation {
                raw_line: Some(Arc::new(vec![
                    GroupedLineSegment {
                        indices: [0, 2],
                        group_code: 1,
                    },
                    GroupedLineSegment {
                        indices: [1, 3],
                        group_code: 2,
                    },
                ])),
                show_points: true,
                x_axis: None,
            },
            width: 240,
            height: 160,
            device_pixel_ratio: 1.0,
            domain: GraphDomain {
                x_min: 0.0,
                x_max: 1.0,
                y_min: 0.0,
                y_max: 1.0,
            },
            points: vec![
                SourcePoint::with_group(1, 0.2, 0.2, 1),
                SourcePoint::with_group(2, 0.2, 0.8, 2),
                SourcePoint::with_group(3, 0.8, 0.8, 1),
                SourcePoint::with_group(4, 0.8, 0.2, 2),
            ],
            overlay,
            enabled_groups,
            mean: Some(Arc::new(vec![
                GroupedMeanPoint {
                    group_code: 1,
                    x: 0.2,
                    y: 0.2,
                },
                GroupedMeanPoint {
                    group_code: 1,
                    x: 0.8,
                    y: 0.8,
                },
                GroupedMeanPoint {
                    group_code: 2,
                    x: 0.2,
                    y: 0.8,
                },
                GroupedMeanPoint {
                    group_code: 2,
                    x: 0.8,
                    y: 0.2,
                },
            ])),
        }
    }

    #[test]
    fn graph_new_phase1_raw_line_camera_basis_preserves_offscreen_slope() {
        let basis = PointBasis { domain: GraphDomain { x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0 }, camera_relative: true };
        assert_eq!(basis.position(&SourcePoint::new(1, -10.0, 0.0)), [-10.0, 0.0]);
        assert_eq!(basis.position(&SourcePoint::new(2, 10.0, 1.0)), [10.0, 1.0]);
    }

    #[test]
    fn graph_new_review_raw_crossing_precision_and_reentry() {
        let mut input = scene();
        input.width = 1000;
        input.height = 800;
        input.points = vec![SourcePoint::new(1, 0.0, 0.0), SourcePoint::new(2, 1.0, 1.0)];
        input.presentation.raw_line = Some(Arc::new(vec![GroupedLineSegment {
            indices: [0, 1],
            group_code: 0,
        }]));
        input.presentation.show_points = false;
        input.domain = GraphDomain { x_min: 0.5, x_max: 0.500001, y_min: 0.50000001, y_max: 0.50000101 };
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).unwrap();
        let frame = pollster::block_on(renderer.render_scene(&input)).unwrap();
        let mut checked = 0;
        for horizontal in 164..884 {
            let expected = 768.0 - (((horizontal as f64 + 0.5 - 64.0) / 920.0) - 0.01) * 752.0;
            for vertical in 16..768 {
                if pixel(&frame, 1000, horizontal, vertical) == [31, 111, 235, 255] {
                    assert!((vertical as f64 + 0.5 - expected).abs() <= 1.5,
                        "crossing shifted at {horizontal},{vertical}; expected {expected}");
                    checked += 1;
                }
            }
        }
        assert!(checked > 600, "crossing missing: {checked}");
        let original = input.domain;
        input.domain.y_min = 0.6;
        input.domain.y_max = 0.600001;
        let hidden = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert!(!(16..768).any(|vertical| (64..984).any(|horizontal|
            pixel(&hidden, 1000, horizontal, vertical) == [31, 111, 235, 255])));
        input.domain = original;
        let restored = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(restored.rgba, frame.rgba);
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
    fn graph_new_mean_native_pixels_toggle_camera_dpr_and_cache() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).unwrap();
        let mut input = scene();
        input.points = vec![SourcePoint::new(1, 0.0, 0.0), SourcePoint::new(2, 1.0, 1.0),
            SourcePoint::new(3, 0.5, 0.5)];
        let mean = std::sync::Arc::new(vec![
            GroupedMeanPoint {
                group_code: 0,
                x: 0.0,
                y: 0.0,
            },
            GroupedMeanPoint {
                group_code: 0,
                x: 1.0,
                y: 1.0,
            },
        ]);
        input.mean = Some(mean.clone());
        for ratio in [1, 2] {
            input.device_pixel_ratio = ratio as f64;
            let frame = pollster::block_on(renderer.render_scene(&input)).unwrap();
            assert_eq!(pixel(&frame, 240 * ratio, 144 * ratio, 72 * ratio), [220, 38, 38, 255]);
            assert_ne!(pixel(&frame, 240 * ratio, 62 * ratio, 72 * ratio), [220, 38, 38, 255]);
        }
        let uploads = renderer.cache_stats().geometry_uploads;
        assert_eq!(renderer.cache_stats().mean_geometry_uploads, 1);
        input.mean = None;
        let off = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert!(!off.rgba.chunks_exact(4).any(|value| value == [220, 38, 38, 255]));
        input.mean = Some(mean);
        input.domain.x_min = 0.25;
        input.domain.x_max = 1.25;
        let panned = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&panned, 480, 208, 144), [220, 38, 38, 255]);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads);
        assert_eq!(renderer.cache_stats().mean_geometry_uploads, 1);
        input.mean = Some(std::sync::Arc::new(vec![GroupedMeanPoint {
            group_code: 0,
            x: 0.5,
            y: 0.5,
        }]));
        let singleton = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert!(!singleton.rgba.chunks_exact(4).any(|value| value == [220, 38, 38, 255]));
    }

    #[test]
    fn graph_new_renderer_overlay_native_colors_and_hidden_visibility() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let overlay_scene = overlay_scene();
        assert_eq!(overlay_scene.enabled_point_count(), 2);

        let frame = pollster::block_on(renderer.render_scene(&overlay_scene)).expect("frame");
        assert!(frame_contains_rgba(&frame.rgba, [220, 38, 38, 255]));
        assert!(!frame_contains_rgba(&frame.rgba, [37, 99, 235, 255]));
        assert!(overlay_scene
            .presentation
            .raw_line
            .as_ref()
            .expect("raw")
            .iter()
            .all(|segment| {
                let start = overlay_scene.points[segment.indices[0] as usize].group_code;
                let end = overlay_scene.points[segment.indices[1] as usize].group_code;
                start == segment.group_code && end == segment.group_code
            }));

        let uploads = renderer.cache_stats().geometry_uploads;
        let repeated = pollster::block_on(renderer.render_scene(&overlay_scene)).expect("repeated");
        assert_eq!(repeated.rgba, frame.rgba);
        assert_eq!(renderer.cache_stats().geometry_uploads, uploads);

        let mut hidden_all = overlay_scene.clone();
        hidden_all.enabled_groups =
            EnabledOverlayMask::from_hidden(&hidden_all.overlay, &["red".to_string(), "blue".to_string()])
                .expect("hide all");
        let empty = pollster::block_on(renderer.render_scene(&hidden_all)).expect("empty");
        assert!(!frame_contains_rgba(&empty.rgba, [220, 38, 38, 255]));
        assert!(!frame_contains_rgba(&empty.rgba, [37, 99, 235, 255]));

        let mut baseline = scene();
        baseline.points = vec![SourcePoint::new(1, 0.3, 0.7)];
        let baseline_frame =
            pollster::block_on(renderer.render_scene(&baseline)).expect("baseline frame");
        assert!(frame_contains_rgba(&baseline_frame.rgba, [31, 111, 235, 255]));
    }

    #[test]
    fn graph_new_mean_deep_zoom_clips_crossing_segments_before_float_conversion() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).unwrap();
        let mut input = scene();
        input.mean = Some(std::sync::Arc::new(vec![
            GroupedMeanPoint {
                group_code: 0,
                x: 0.0,
                y: 0.0,
            },
            GroupedMeanPoint {
                group_code: 0,
                x: 1.0,
                y: 1.0,
            },
        ]));
        pollster::block_on(renderer.render_scene(&input)).unwrap();
        input.domain = GraphDomain { x_min: 0.5, x_max: 0.5 + 1e-9,
            y_min: 0.5 + 0.25e-9, y_max: 0.5 + 1.25e-9 };
        let frame = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(pixel(&frame, 240, 144, 100), [220, 38, 38, 255]);
        assert_ne!(pixel(&frame, 240, 144, 72), [220, 38, 38, 255]);
        let repeated = pollster::block_on(renderer.render_scene(&input)).unwrap();
        assert_eq!(frame.rgba, repeated.rgba);
        assert_eq!(renderer.cache_stats().mean_geometry_uploads, 2);
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
    fn graph_new_dense_points_use_one_pixel_radius_without_camera_uploads() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("renderer");
        let mut input = scene();
        input.points = (1..=50_001).map(|row_id| SourcePoint::new(row_id, 0.3, 0.7)).collect();
        for ratio in [1, 2] {
            input.device_pixel_ratio = ratio as f64;
            let frame = pollster::block_on(renderer.render_scene(&input)).expect("dense frame");
            assert_eq!(pixel(&frame, 240 * ratio, 112 * ratio, 49 * ratio), [31, 111, 235, 255]);
            assert_ne!(pixel(&frame, 240 * ratio, 114 * ratio, 49 * ratio), [31, 111, 235, 255],
                "large point sets must not use the three-pixel radius");
            assert_eq!(renderer.cache_stats().geometry_uploads, 1);
        }
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
        assert_eq!(stats.allocated_bytes, stats.geometry_capacity_bytes + 64
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
    fn graph_new_exact_cap_respects_replacement_and_target_budget() {
        assert_eq!(std::mem::size_of::<Mark>(), 40);
        let geometry = (MAX_SCENE_POINTS as u64 + 1024) * 40 + 48
            + u64::from(ATLAS_WIDTH) * u64::from(ATLAS_HEIGHT);
        let target = 1280 * 720 * 8;
        let limit = super::super::graph_new_cache::DEFAULT_GPU_BYTES;
        assert!(check_gpu_budget(geometry + target, geometry + target, limit).is_ok());
        let maximum_target = 3840 * 2160 * 8;
        assert!(check_gpu_budget(geometry + maximum_target, geometry + maximum_target, limit).is_err());
        let four_million_geometry = (4_000_000 + 1024) * 40;
        assert!(check_gpu_budget(four_million_geometry, four_million_geometry + target, limit).is_err());
        assert!(MAX_SCENE_POINTS as u64 * 112 + 8 * 1024 * 1024 + 65536 + 8192 < 256 * 1024 * 1024);
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
