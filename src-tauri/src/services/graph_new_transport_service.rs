use super::graph_new_renderer::{GraphNewScene, ScenePipeline};
use crate::error::AppError;

use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::models::graph_new::{
    GraphNewFrameHeader, GraphNewTransportProbeCompletion, GraphNewTransportProbeRequest,
};

const COPY_BYTES_PER_ROW_ALIGNMENT: u32 = 256;
const RGBA8_BYTES_PER_PIXEL: u32 = 4;

enum FrameSinkError {
    Closed,
    Invalid(String),
}

trait FrameSink {
    fn send_header(&mut self, header: &GraphNewFrameHeader) -> Result<(), FrameSinkError>;
    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), FrameSinkError>;
}

struct ChannelFrameSink<'a> {
    on_frame: &'a Channel<InvokeResponseBody>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameHeaderMessage<'a> {
    message_type: &'static str,
    header: &'a GraphNewFrameHeader,
}

impl FrameSink for ChannelFrameSink<'_> {
    fn send_header(&mut self, header: &GraphNewFrameHeader) -> Result<(), FrameSinkError> {
        let message = FrameHeaderMessage {
            message_type: "header",
            header,
        };
        let serialized = serde_json::to_string(&message)
            .map_err(|error| FrameSinkError::Invalid(error.to_string()))?;
        self.on_frame
            .send(InvokeResponseBody::from(serialized))
            .map_err(|_| FrameSinkError::Closed)
    }

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), FrameSinkError> {
        self.on_frame
            .send(InvokeResponseBody::from(payload))
            .map_err(|_| FrameSinkError::Closed)
    }
}

#[cfg(test)]
#[derive(Default)]
struct CollectingFrameSink {
    headers: Vec<GraphNewFrameHeader>,
    payloads: Vec<Vec<u8>>,
    send_order: Vec<&'static str>,
}

#[cfg(test)]
impl FrameSink for CollectingFrameSink {
    fn send_header(&mut self, header: &GraphNewFrameHeader) -> Result<(), FrameSinkError> {
        self.headers.push(header.clone());
        self.send_order.push("header");
        Ok(())
    }

    fn send_payload(&mut self, payload: Vec<u8>) -> Result<(), FrameSinkError> {
        self.payloads.push(payload);
        self.send_order.push("payload");
        Ok(())
    }
}

pub struct GraphNewTransportService;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum GpuFailure {
    DeviceLost = 1,
    Internal = 2,
    Readback = 3,
    Validation = 4,
    OutOfMemory = 5,
}

impl GpuFailure {
    fn error(self) -> AppError {
        AppError::Stats(match self {
            Self::DeviceLost => "graph_new_gpu_device_lost",
            Self::Internal => "graph_new_gpu_internal",
            Self::Readback => "graph_new_gpu_readback",
            Self::Validation => "graph_new_gpu_validation",
            Self::OutOfMemory => "graph_new_gpu_out_of_memory",
        }.into())
    }

    fn from_error(error: &AppError) -> Option<Self> {
        let AppError::Stats(message) = error else { return None; };
        match message.as_str() {
            "graph_new_gpu_device_lost" => Some(Self::DeviceLost),
            "graph_new_gpu_internal" => Some(Self::Internal),
            "graph_new_gpu_readback" => Some(Self::Readback),
            "graph_new_gpu_validation" => Some(Self::Validation),
            "graph_new_gpu_out_of_memory" => Some(Self::OutOfMemory),
            _ => None,
        }
    }
}

pub(crate) fn recover_renderer<Renderer, Output>(
    slot: &mut Option<Renderer>,
    retried: &mut bool,
    mut create: impl FnMut() -> Result<Renderer, AppError>,
    mut render: impl FnMut(&mut Renderer) -> Result<Output, AppError>,
    mut current: impl FnMut() -> bool,
) -> Result<Output, AppError> {
    for attempt in 0..2 {
        if !current() { return Err(AppError::Stats("graph_new_cancelled".into())); }
        if slot.is_none() { *slot = Some(create()?); }
        let renderer = slot.as_mut().ok_or_else(|| GpuFailure::Internal.error())?;
        match render(renderer) {
            Ok(output) => return if current() { Ok(output) } else { Err(AppError::Stats("graph_new_cancelled".into())) },
            Err(error) => {
                let failure = GpuFailure::from_error(&error);
                if failure.is_some() { *slot = None; }
                if failure != Some(GpuFailure::DeviceLost) || *retried || attempt != 0 {
                    return Err(error);
                }
                *retried = true;
            }
        }
    }
    Err(GpuFailure::DeviceLost.error())
}

pub(crate) fn session_renderer() -> &'static Mutex<Option<SyntheticFrameRenderer>> {
    static RENDERER: OnceLock<Mutex<Option<SyntheticFrameRenderer>>> = OnceLock::new();
    RENDERER.get_or_init(|| Mutex::new(None))
}

fn latest_probe_generation() -> &'static AtomicU64 {
    static GENERATION: AtomicU64 = AtomicU64::new(0);
    &GENERATION
}

impl GraphNewTransportService {
    pub fn new() -> Self {
        Self
    }

    pub fn probe(
        &self,
        request: &GraphNewTransportProbeRequest,
        on_frame: &Channel<InvokeResponseBody>,
    ) -> Result<GraphNewTransportProbeCompletion, AppError> {
        request.validate()?;
        let generation = latest_probe_generation().fetch_add(1, Ordering::AcqRel) + 1;
        let mut sink = ChannelFrameSink { on_frame };
        let mut renderer_guard = session_renderer()
            .lock()
            .map_err(|_| AppError::Stats("graph-new renderer lock poisoned".to_owned()))?;
        let current = || latest_probe_generation().load(Ordering::Acquire) == generation;
        let mut retried = false;
        self.probe_frames(request, &mut sink, || recover_renderer(&mut renderer_guard, &mut retried,
            || pollster::block_on(SyntheticFrameRenderer::new()),
            |renderer| pollster::block_on(renderer.render(request.width, request.height)), current), current)
    }

    #[cfg(test)]
    fn probe_with_sink(
        &self,
        request: &GraphNewTransportProbeRequest,
        sink: &mut impl FrameSink,
    ) -> Result<GraphNewTransportProbeCompletion, AppError> {
        request.validate()?;
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new())?;
        self.probe_with_renderer(request, sink, &mut renderer, || true)
    }

    #[cfg(test)]
    fn probe_with_renderer(
        &self,
        request: &GraphNewTransportProbeRequest,
        sink: &mut impl FrameSink,
        renderer: &mut SyntheticFrameRenderer,
        is_current: impl FnMut() -> bool,
    ) -> Result<GraphNewTransportProbeCompletion, AppError> {
        self.probe_frames(request, sink,
            || pollster::block_on(renderer.render(request.width, request.height)), is_current)
    }

    fn probe_frames(
        &self,
        request: &GraphNewTransportProbeRequest,
        sink: &mut impl FrameSink,
        mut render: impl FnMut() -> Result<SyntheticFrame, AppError>,
        mut is_current: impl FnMut() -> bool,
    ) -> Result<GraphNewTransportProbeCompletion, AppError> {
        let byte_length = request.rgba_byte_length()?;
        let mut render_ms = Vec::with_capacity(request.frames as usize);
        let mut readback_ms = Vec::with_capacity(request.frames as usize);
        let mut frames_sent = 0;
        let mut dropped_superseded_frames = 0;
        let mut maximum_queue_depth = 0;

        for frame_index in 0..request.frames {
            if !is_current() {
                break;
            }
            let frame = render()?;
            maximum_queue_depth = 1;
            if !is_current() {
                dropped_superseded_frames += 1;
                break;
            }
            let readback_completed_at_unix_micros = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| AppError::Stats("system clock is before the Unix epoch".to_owned()))?
                .as_micros()
                .try_into()
                .map_err(|_| AppError::Stats("system clock timestamp overflow".to_owned()))?;
            let header = GraphNewFrameHeader {
                request_id: request.request_id.clone(),
                dataset_generation: 0,
                renderer_generation: 0,
                camera_generation: 0,
                frame_id: u64::from(frame_index) + 1,
                width: request.width,
                height: request.height,
                format: request.format,
                byte_length,
                readback_completed_at_unix_micros,
            };
            sink.send_header(&header).map_err(map_sink_error)?;
            sink.send_payload(frame.rgba).map_err(map_sink_error)?;
            render_ms.push(frame.render_ms);
            readback_ms.push(frame.readback_ms);
            frames_sent += 1;
        }

        Ok(GraphNewTransportProbeCompletion {
            request_id: request.request_id.clone(),
            frames_requested: request.frames,
            frames_sent,
            dropped_superseded_frames,
            peak_transport_bytes: if frames_sent > 0 { byte_length } else { 0 },
            maximum_queue_depth,
            render_ms,
            readback_ms,
        })
    }
}

fn map_sink_error(error: FrameSinkError) -> AppError {
    match error {
        FrameSinkError::Closed => {
            AppError::InvalidParam("graph-new frame channel closed".to_owned())
        }
        FrameSinkError::Invalid(message) => AppError::Stats(format!(
            "graph-new frame header serialization failed: {message}"
        )),
    }
}

fn padded_bytes_per_row(width: u32) -> Result<u32, AppError> {
    let unpadded = width
        .checked_mul(RGBA8_BYTES_PER_PIXEL)
        .ok_or_else(|| AppError::InvalidParam("graph-new row byte length overflow".to_owned()))?;
    let remainder = unpadded % COPY_BYTES_PER_ROW_ALIGNMENT;
    if remainder == 0 {
        return Ok(unpadded);
    }
    unpadded
        .checked_add(COPY_BYTES_PER_ROW_ALIGNMENT - remainder)
        .ok_or_else(|| AppError::InvalidParam("graph-new padded row length overflow".to_owned()))
}

pub(crate) struct SyntheticFrame {
    pub(crate) rgba: Vec<u8>,
    #[cfg(test)]
    pub(crate) padded_bytes_per_row: u32,
    pub(crate) render_ms: f64,
    pub(crate) readback_ms: f64,
}

struct ReadbackTarget {
    width: u32,
    height: u32,
    padded_bytes_per_row: u32,
    texture: wgpu::Texture,
    texture_view: wgpu::TextureView,
    staging: wgpu::Buffer,
}

struct UnmapOnDrop<'a>(&'a wgpu::Buffer);

impl Drop for UnmapOnDrop<'_> {
    fn drop(&mut self) { self.0.unmap(); }
}

pub(crate) struct SyntheticFrameRenderer {
    failure: Arc<AtomicU8>,
    #[cfg(test)]
    readback_fault: Option<GpuFailure>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    scene_pipeline: Option<ScenePipeline>,
    target: Option<ReadbackTarget>,
    #[cfg(test)]
    target_allocations: u32,
}

impl SyntheticFrameRenderer {
    fn failure(&self) -> Option<GpuFailure> {
        match self.failure.load(Ordering::Acquire) {
            0 => None,
            1 => Some(GpuFailure::DeviceLost),
            2 => Some(GpuFailure::Internal),
            3 => Some(GpuFailure::Readback),
            4 => Some(GpuFailure::Validation),
            _ => Some(GpuFailure::OutOfMemory),
        }
    }

    fn readback_error(&self) -> AppError {
        self.failure().unwrap_or(GpuFailure::Readback).error()
    }

    pub(crate) fn cache_stats(&self) -> crate::models::graph_new::GraphNewGpuCacheStats {
        let mut stats = self.scene_pipeline.as_ref().map_or_else(Default::default, ScenePipeline::cache_stats);
        if let Some(target) = &self.target {
            stats.allocated_bytes += u64::from(target.width) * u64::from(target.height) * 4 + target.staging.size();
        }
        stats
    }

    pub(crate) async fn new() -> Result<Self, AppError> {
        let instance = wgpu::Instance::default();
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface: None,
                ..Default::default()
            })
            .await
            .map_err(|_| AppError::Stats("graph-new GPU adapter unavailable".to_owned()))?;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor::default())
            .await
            .map_err(|_| AppError::Stats("graph-new GPU device unavailable".to_owned()))?;
        let failure = Arc::new(AtomicU8::new(0));
        let lost = failure.clone();
        device.set_device_lost_callback(move |reason, _message| {
            if reason == wgpu::DeviceLostReason::Unknown {
                lost.fetch_max(GpuFailure::DeviceLost as u8, Ordering::AcqRel);
            }
        });
        let uncaptured = failure.clone();
        device.on_uncaptured_error(Arc::new(move |error| {
            let category = match error {
                wgpu::Error::OutOfMemory { .. } => GpuFailure::OutOfMemory,
                wgpu::Error::Validation { .. } => GpuFailure::Validation,
                wgpu::Error::Internal { .. } => GpuFailure::Internal,
            };
            uncaptured.fetch_max(category as u8, Ordering::AcqRel);
        }));
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("graph-new synthetic point shader"),
            source: wgpu::ShaderSource::Wgsl(
                r#"
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
    let corners = array<vec2<f32>, 6>(
        vec2<f32>(-0.06, -0.06),
        vec2<f32>( 0.06, -0.06),
        vec2<f32>( 0.06,  0.06),
        vec2<f32>(-0.06, -0.06),
        vec2<f32>( 0.06,  0.06),
        vec2<f32>(-0.06,  0.06),
    );
    let centers = array<vec2<f32>, 3>(
        vec2<f32>(-0.55, -0.35),
        vec2<f32>( 0.00,  0.20),
        vec2<f32>( 0.58, -0.05),
    );
    var output: VertexOutput;
    output.position = vec4<f32>(centers[instance_index] + corners[vertex_index], 0.0, 1.0);
    return output;
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(31.0 / 255.0, 111.0 / 255.0, 235.0 / 255.0, 1.0);
}
"#
                .into(),
            ),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("graph-new synthetic point pipeline layout"),
            bind_group_layouts: &[],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("graph-new synthetic point pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });

        Ok(Self {
            failure,
            #[cfg(test)]
            readback_fault: None,
            device,
            queue,
            pipeline,
            scene_pipeline: None,
            target: None,
            #[cfg(test)]
            target_allocations: 0,
        })
    }

    fn ensure_target(&mut self, width: u32, height: u32) -> Result<(), AppError> {
        if self
            .target
            .as_ref()
            .is_some_and(|target| target.width == width && target.height == height)
        {
            return Ok(());
        }

        let padded_bytes_per_row = padded_bytes_per_row(width)?;
        let padded_size = u64::from(padded_bytes_per_row)
            .checked_mul(u64::from(height))
            .ok_or_else(|| {
                AppError::InvalidParam("graph-new staging buffer size overflow".to_owned())
            })?;
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("graph-new synthetic offscreen texture"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let texture_view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let staging = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("graph-new synthetic readback buffer"),
            size: padded_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        self.target = Some(ReadbackTarget {
            width,
            height,
            padded_bytes_per_row,
            texture,
            texture_view,
            staging,
        });
        #[cfg(test)]
        {
            self.target_allocations += 1;
        }
        Ok(())
    }

    pub(crate) async fn render(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<SyntheticFrame, AppError> {
        self.render_frame(width, height, None).await
    }

    pub(crate) async fn render_scene(
        &mut self,
        scene: &GraphNewScene,
    ) -> Result<SyntheticFrame, AppError> {
        let (width, height) = scene.physical_size()?;
        self.render_frame(width, height, Some(scene)).await
    }

    fn planned_gpu_bytes(&self, width: u32, height: u32, scene: Option<&GraphNewScene>) -> Result<u64, AppError> {
        let target_bytes = if self.target.as_ref().is_some_and(|target| target.width == width && target.height == height) { 0 }
            else { u64::from(width) * u64::from(height) * 4 + u64::from(padded_bytes_per_row(width)?) * u64::from(height) };
        let upload_bytes = scene.map_or(0, |scene| scene.point_upload_bytes() + 1024 * 40 + 64
            + scene.mean.as_ref().map_or(16, |mean| mean.len().saturating_sub(1).max(1) as u64 * 16)
            + scene.raw_upload_bytes()
            + u64::from(super::graph_new_text::ATLAS_WIDTH) * u64::from(super::graph_new_text::ATLAS_HEIGHT));
        let replacement_bytes = scene.map_or(0, |scene| self.scene_pipeline.as_ref()
            .map_or(upload_bytes + 96, |pipeline| pipeline.replacement_bytes(scene)));
        Ok(self.cache_stats().allocated_bytes.saturating_add(upload_bytes)
            .saturating_add(replacement_bytes).saturating_add(target_bytes))
    }

    async fn render_frame(
        &mut self,
        width: u32,
        height: u32,
        scene: Option<&GraphNewScene>,
    ) -> Result<SyntheticFrame, AppError> {
        if width == 0 || height == 0 || width > 3840 || height > 2160 {
            return Err(AppError::InvalidParam("graph_new_invalid_request".into()));
        }
        if let Some(failure) = self.failure() { return Err(failure.error()); }
        let render_started = Instant::now();
        let mut planned = self.planned_gpu_bytes(width, height, scene)?;
        if self.failure().is_none() && planned > super::graph_new_cache::DEFAULT_GPU_BYTES && scene.is_some_and(|scene| scene.mean.is_none()) {
            if let Some(pipeline) = self.scene_pipeline.as_mut() {
                pipeline.reclaim_inactive_mean(&self.device);
                planned = self.planned_gpu_bytes(width, height, scene)?;
            }
        }
        if self.failure().is_none() && planned > super::graph_new_cache::DEFAULT_GPU_BYTES && scene.is_some_and(|scene| scene.presentation.raw_line.is_none()) {
            if let Some(pipeline) = self.scene_pipeline.as_mut() {
                pipeline.reclaim_inactive_raw(&self.device);
                planned = self.planned_gpu_bytes(width, height, scene)?;
            }
        }
        super::graph_new_renderer::check_gpu_budget(0, planned,
            super::graph_new_cache::DEFAULT_GPU_BYTES)?;
        if let Some(scene) = scene {
            let pipeline = self
                .scene_pipeline
                .get_or_insert_with(|| ScenePipeline::new(&self.device, &self.queue));
            pipeline.prepare(&self.device, &self.queue, scene)?;
        }
        self.ensure_target(width, height)?;
        let Some(target) = self.target.as_ref() else {
            return Err(AppError::Stats(
                "graph-new readback target unavailable".to_owned(),
            ));
        };
        let padded_bytes_per_row = target.padded_bytes_per_row;

        let render_started = if scene.is_some() {
            render_started
        } else {
            Instant::now()
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("graph-new synthetic frame encoder"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("graph-new synthetic point pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &target.texture_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(if scene.is_some() {
                            wgpu::Color::WHITE
                        } else {
                            wgpu::Color {
                                r: 248.0 / 255.0,
                                g: 250.0 / 255.0,
                                b: 252.0 / 255.0,
                                a: 1.0,
                            }
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            if scene.is_some() {
                if let Some(pipeline) = self.scene_pipeline.as_ref() {
                    pipeline.draw(&mut pass);
                }
            } else {
                pass.set_pipeline(&self.pipeline);
                pass.draw(0..6, 0..3);
            }
        }
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &target.staging,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(Some(encoder.finish()));
        let render_ms = render_started.elapsed().as_secs_f64() * 1_000.0;

        let readback_started = Instant::now();
        let slice = target.staging.slice(..);
        let (sender, receiver) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        let _unmap = UnmapOnDrop(&target.staging);
        #[cfg(test)]
        if let Some(failure) = self.readback_fault.take() { return Err(failure.error()); }
        self.device
            .poll(wgpu::PollType::Wait { submission_index: None, timeout: Some(Duration::from_secs(5)) })
            .map_err(|_| self.readback_error())?;
        receiver
            .recv_timeout(Duration::from_secs(1))
            .map_err(|_| self.readback_error())?
            .map_err(|_| self.readback_error())?;
        if let Some(failure) = self.failure() { return Err(failure.error()); }
        let mapped = slice
            .get_mapped_range()
            .map_err(|_| self.readback_error())?;
        let unpadded_bytes_per_row = usize::try_from(width)
            .ok()
            .and_then(|value| value.checked_mul(RGBA8_BYTES_PER_PIXEL as usize))
            .ok_or_else(|| AppError::InvalidParam("graph-new row size overflow".to_owned()))?;
        let output_capacity = unpadded_bytes_per_row
            .checked_mul(height as usize)
            .ok_or_else(|| AppError::InvalidParam("graph-new frame size overflow".to_owned()))?;
        let mut rgba = Vec::new();
        rgba.try_reserve_exact(output_capacity).map_err(|_| GpuFailure::OutOfMemory.error())?;
        for row in mapped.chunks_exact(padded_bytes_per_row as usize) {
            rgba.extend_from_slice(&row[..unpadded_bytes_per_row]);
        }
        drop(mapped);
        if let Some(failure) = self.failure() { return Err(failure.error()); }
        let readback_ms = readback_started.elapsed().as_secs_f64() * 1_000.0;

        Ok(SyntheticFrame {
            rgba,
            #[cfg(test)]
            padded_bytes_per_row,
            render_ms,
            readback_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use crate::models::graph_new::GraphNewOverlayGroup;
    use crate::services::graph_new_overlay::{
        EnabledOverlayMask, GroupedLineSegment, GroupedMeanPoint, OverlayCatalog,
    };

    fn all_rows_overlay() -> (OverlayCatalog, EnabledOverlayMask) {
        let overlay = OverlayCatalog::default();
        let enabled = EnabledOverlayMask::from_hidden(&overlay, &[]).expect("enabled");
        (overlay, enabled)
    }

    fn grouped_overlay(total_rows: u64) -> (OverlayCatalog, EnabledOverlayMask) {
        let overlay = OverlayCatalog {
            active: true,
            groups: vec![GraphNewOverlayGroup {
                id: "group-0".into(),
                code: 0,
                label: "group-0".into(),
                color: [31, 111, 235, 255],
                total_rows,
                missing: false,
            }],
        };
        let enabled = EnabledOverlayMask::from_hidden(&overlay, &[]).expect("enabled");
        (overlay, enabled)
    }

    #[test]
    fn graph_new_recovery_releases_before_one_device_loss_retry() {
        struct Device<'a>(&'a Cell<usize>);
        impl Drop for Device<'_> { fn drop(&mut self) { self.0.set(self.0.get() - 1); } }
        let live = Cell::new(1);
        let calls = Cell::new(0);
        let mut slot = Some(Device(&live));
        let mut retried = false;
        let result = super::recover_renderer(&mut slot, &mut retried, || {
            assert_eq!(live.get(), 0, "old device must be released first");
            live.set(1);
            Ok(Device(&live))
        }, |_| {
            calls.set(calls.get() + 1);
            if calls.get() == 1 { Err(crate::error::AppError::Stats("graph_new_gpu_device_lost".into())) }
            else { Ok(42) }
        }, || true);
        assert_eq!(result.expect("recovered"), 42);
        assert_eq!(calls.get(), 2);
        assert!(retried);
    }

    #[test]
    fn graph_new_recovery_never_retries_pressure_oom_or_repeated_loss() {
        for (message, expected_calls, cleared) in [
            ("graph_new_cache_pressure", 1, false),
            ("graph_new_gpu_out_of_memory", 1, true),
            ("graph_new_gpu_validation", 1, true),
            ("graph_new_gpu_readback", 1, true),
            ("graph_new_gpu_device_lost", 2, true),
        ] {
            let calls = Cell::new(0);
            let mut slot = Some(());
            let result: Result<(), _> = super::recover_renderer(&mut slot, &mut false, || Ok(()), |_| {
                calls.set(calls.get() + 1);
                Err(crate::error::AppError::Stats(message.into()))
            }, || true);
            assert!(result.is_err());
            assert_eq!(calls.get(), expected_calls, "{message}");
            assert_eq!(slot.is_none(), cleared, "{message}");
            let result = super::recover_renderer(&mut slot, &mut false, || Ok(()), |_| Ok(7), || true);
            assert_eq!(result.expect("next request"), 7);
        }
    }

    #[test]
    fn graph_new_recovery_cancelled_generation_does_not_recreate() {
        let current = Cell::new(true);
        let mut slot = Some(());
        let result: Result<(), _> = super::recover_renderer(&mut slot, &mut false, || panic!("cancelled recreate"), |_| {
            current.set(false);
            Err(crate::error::AppError::Stats("graph_new_gpu_device_lost".into()))
        }, || current.get());
        assert!(result.is_err());
        assert!(slot.is_none());
    }

    #[test]
    fn graph_new_recovery_callback_fault_recreates_and_renders_real_pixels() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU");
        let original = pollster::block_on(renderer.render(128, 96)).expect("original");
        renderer.failure.store(super::GpuFailure::DeviceLost as u8, std::sync::atomic::Ordering::Release);
        let mut slot = Some(renderer);
        let mut retried = false;
        let recovered = super::recover_renderer(&mut slot, &mut retried,
            || pollster::block_on(SyntheticFrameRenderer::new()),
            |renderer| pollster::block_on(renderer.render(128, 96)), || true).expect("recovery");
        assert!(retried);
        assert_eq!(original.rgba, recovered.rgba);
        let renderer = slot.as_mut().expect("new device");
        renderer.failure.store(super::GpuFailure::OutOfMemory as u8, std::sync::atomic::Ordering::Release);
        let error = pollster::block_on(renderer.render(128, 96)).err().expect("OOM");
        assert_eq!(super::GpuFailure::from_error(&error), Some(super::GpuFailure::OutOfMemory));
    }

    #[test]
    fn graph_new_recovery_production_probe_and_scene_share_loss_recovery() {
        let renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU");
        renderer.failure.store(super::GpuFailure::DeviceLost as u8, std::sync::atomic::Ordering::Release);
        *super::session_renderer().lock().expect("renderer") = Some(renderer);
        let request = GraphNewTransportProbeRequest { request_id: "recovery".into(), width: 128, height: 96,
            frames: 1, format: GraphNewFrameFormat::Rgba8 };
        let channel = tauri::ipc::Channel::new(|_| Ok(()));
        let completion = GraphNewTransportService::new().probe(&request, &channel).expect("production probe");
        assert_eq!(completion.frames_sent, 1);
        {
            let guard = super::session_renderer().lock().expect("renderer");
            guard.as_ref().expect("retained").failure.store(super::GpuFailure::DeviceLost as u8, std::sync::atomic::Ordering::Release);
        }
        let (overlay, enabled_groups) = all_rows_overlay();
        let scene = super::GraphNewScene { width: 128, height: 96, device_pixel_ratio: 1.0,
            presentation: Default::default(),
            domain: crate::services::graph_new_lod::GraphDomain { x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
            points: vec![crate::services::graph_new_lod::SourcePoint::new(1, 0.5, 0.5)],
            overlay, enabled_groups, mean: None };
        let frame = crate::services::graph_new_renderer::GraphNewRenderer::render_current(&scene, || true).expect("production scene");
        assert!(frame.rgba.chunks_exact(4).any(|pixel| pixel[2] > 180 && pixel[0] < 100));
        assert!(crate::services::graph_new_renderer::GraphNewRenderer::render_current(&scene, || false).is_err());
        *super::session_renderer().lock().expect("cleanup") = None;
    }

    #[test]
    fn graph_new_recovery_readback_failure_unmaps_before_next_frame() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU");
        renderer.readback_fault = Some(super::GpuFailure::Readback);
        let error = pollster::block_on(renderer.render(128, 96)).err().expect("injected map failure");
        assert_eq!(super::GpuFailure::from_error(&error), Some(super::GpuFailure::Readback));
        let frame = pollster::block_on(renderer.render(128, 96)).expect("next frame");
        assert_eq!(frame.rgba.len(), 128 * 96 * 4);
        assert_eq!(renderer.target_allocations, 1, "same staging buffer is usable again");
    }

    fn retained_pressure_fixture() -> (SyntheticFrameRenderer, super::GraphNewScene) {
        use crate::services::graph_new_lod::{GraphDomain, SourcePoint};

        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU");
        let (overlay, enabled_groups) = all_rows_overlay();
        let mut scene = super::GraphNewScene {
            presentation: Default::default(),
            width: 128, height: 96, device_pixel_ratio: 1.0,
            domain: GraphDomain { x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
            points: vec![SourcePoint::new(1, 0.5, 0.25)],
            overlay,
            enabled_groups,
            mean: Some(std::sync::Arc::new(vec![
                GroupedMeanPoint { group_code: 0, x: 0.0, y: 0.5 },
                GroupedMeanPoint { group_code: 0, x: 1.0, y: 0.5 },
            ])),
        };
        pollster::block_on(renderer.render_scene(&scene)).expect("retained Mean scene");
        assert_eq!(renderer.cache_stats().mean_geometry_uploads, 1);
        renderer.target.as_mut().expect("retained target").width =
            (super::super::graph_new_cache::DEFAULT_GPU_BYTES / (96 * 4) + 1) as u32;
        scene.points.resize(100, SourcePoint::new(2, 0.5, 0.25));
        scene.mean = None;
        assert!(renderer.planned_gpu_bytes(128, 96, Some(&scene)).expect("budget")
            > super::super::graph_new_cache::DEFAULT_GPU_BYTES);
        (renderer, scene)
    }

    #[test]
    fn graph_new_recovery_ordering_loss_precedes_retained_pressure() {
        let (renderer, scene) = retained_pressure_fixture();
        renderer.failure.store(super::GpuFailure::DeviceLost as u8, std::sync::atomic::Ordering::Release);
        let mut slot = Some(renderer);
        let mut retried = false;
        let creations = Cell::new(0);
        let attempts = Cell::new(0);
        let result = super::recover_renderer(&mut slot, &mut retried, || {
            creations.set(creations.get() + 1);
            let renderer = pollster::block_on(SyntheticFrameRenderer::new())?;
            assert!(renderer.planned_gpu_bytes(128, 96, Some(&scene))?
                <= super::super::graph_new_cache::DEFAULT_GPU_BYTES);
            Ok(renderer)
        }, |renderer| {
            attempts.set(attempts.get() + 1);
            pollster::block_on(renderer.render_scene(&scene))
        }, || true);
        let frame = result.unwrap_or_else(|error| panic!("lost renderer must recover before pressure admission: {error}"));
        assert!(retried);
        assert_eq!(creations.get(), 1);
        assert_eq!(attempts.get(), 2);
        assert!(frame.rgba.chunks_exact(4).any(|pixel| pixel == [31, 111, 235, 255]));
        assert_eq!(slot.as_ref().expect("fresh renderer").failure(), None);
    }

    #[test]
    fn graph_new_recovery_ordering_healthy_pressure_does_not_retry() {
        let (renderer, scene) = retained_pressure_fixture();
        let mut slot = Some(renderer);
        let mut retried = false;
        let attempts = Cell::new(0);
        let result = super::recover_renderer(&mut slot, &mut retried,
            || panic!("healthy pressure must not recreate"), |renderer| {
                attempts.set(attempts.get() + 1);
                pollster::block_on(renderer.render_scene(&scene))
            }, || true);
        assert!(matches!(result, Err(crate::error::AppError::Stats(message)) if message == "graph_new_cache_pressure"));
        assert!(!retried);
        assert_eq!(attempts.get(), 1);
        assert_eq!(slot.as_ref().expect("healthy renderer retained").failure(), None);
    }

    #[test]
    fn graph_new_recovery_ordering_invalid_scene_precedes_loss() {
        let (renderer, mut scene) = retained_pressure_fixture();
        renderer.failure.store(super::GpuFailure::DeviceLost as u8, std::sync::atomic::Ordering::Release);
        let mut slot = Some(renderer);
        for invalid in 0..3 {
            scene.width = if invalid == 0 { 0 } else { 128 };
            scene.domain.x_max = if invalid == 1 { f64::NAN } else { 1.0 };
            scene.points[0].x = if invalid == 2 { f64::NAN } else { 0.5 };
            let mut retried = false;
            let attempts = Cell::new(0);
            let result = super::recover_renderer(&mut slot, &mut retried,
                || panic!("invalid input must not recreate"), |renderer| {
                    attempts.set(attempts.get() + 1);
                    pollster::block_on(renderer.render_scene(&scene))
                }, || true);
            assert!(matches!(result, Err(crate::error::AppError::InvalidParam(_))));
            assert!(!retried);
            assert_eq!(attempts.get(), 1);
            assert_eq!(slot.as_ref().expect("not retried").failure(), Some(super::GpuFailure::DeviceLost));
        }
    }

    use crate::models::graph_new::{GraphNewFrameFormat, GraphNewTransportProbeRequest};

    use super::{
        padded_bytes_per_row, CollectingFrameSink, FrameSink, FrameSinkError,
        GraphNewTransportService, SyntheticFrameRenderer,
    };

    #[derive(Default)]
    struct ClosingFrameSink {
        send_calls: u32,
    }

    impl FrameSink for ClosingFrameSink {
        fn send_header(
            &mut self,
            _header: &crate::models::graph_new::GraphNewFrameHeader,
        ) -> Result<(), FrameSinkError> {
            self.send_calls += 1;
            Ok(())
        }

        fn send_payload(&mut self, _payload: Vec<u8>) -> Result<(), FrameSinkError> {
            self.send_calls += 1;
            Err(FrameSinkError::Closed)
        }
    }

    #[test]
    fn accepts_the_4k_rgba8_gate_dimensions() {
        let request = GraphNewTransportProbeRequest::rgba8("probe", 3840, 2160, 1);

        assert!(request.validate().is_ok());
        assert_eq!(
            request.rgba_byte_length().expect("valid byte length"),
            33_177_600
        );
    }

    #[test]
    fn rejects_frame_dimensions_above_the_4k_gate() {
        let request = GraphNewTransportProbeRequest::rgba8("probe", 4096, 2160, 1);

        let error = request.validate().expect_err("width above gate must fail");

        assert!(error.to_string().contains("width"));
    }

    #[test]
    fn rejects_zero_frames_and_empty_request_ids() {
        let zero_frames = GraphNewTransportProbeRequest::rgba8("probe", 1920, 1080, 0);
        let queued_frames = GraphNewTransportProbeRequest::rgba8("probe", 1920, 1080, 2);
        let empty_id = GraphNewTransportProbeRequest::rgba8("  ", 1920, 1080, 1);

        assert!(zero_frames.validate().is_err());
        assert!(queued_frames.validate().is_err());
        assert!(empty_id.validate().is_err());
    }

    #[test]
    fn padded_bytes_per_row_is_wgpu_aligned() {
        assert_eq!(padded_bytes_per_row(3840).expect("aligned width"), 15_360);
        assert_eq!(padded_bytes_per_row(1921).expect("padded width") % 256, 0);
    }

    #[test]
    fn padded_bytes_per_row_rejects_overflow() {
        assert!(padded_bytes_per_row(u32::MAX).is_err());
    }

    #[test]
    fn renders_and_reads_back_a_synthetic_point_frame() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new())
            .expect("test adapter must render an offscreen frame");

        let frame =
            pollster::block_on(renderer.render(64, 32)).expect("synthetic frame must render");

        assert_eq!(frame.rgba.len(), 64 * 32 * 4);
        assert_eq!(frame.padded_bytes_per_row % 256, 0);
        assert!(frame.render_ms >= 0.0);
        assert!(frame.readback_ms >= 0.0);
        assert!(frame
            .rgba
            .chunks_exact(4)
            .any(|pixel| pixel == [248, 250, 252, 255]));
        assert!(frame
            .rgba
            .chunks_exact(4)
            .any(|pixel| pixel == [31, 111, 235, 255]));
    }

    #[test]
    fn reuses_the_readback_target_for_same_size_frames() {
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new())
            .expect("test adapter must create a renderer");

        pollster::block_on(renderer.render(64, 32)).expect("first frame must render");
        pollster::block_on(renderer.render(64, 32)).expect("second frame must render");

        assert_eq!(renderer.target_allocations, 1);
    }

    #[test]
    fn graph_new_mean_inactive_buffer_reclaimed_only_under_budget_pressure() {
        use crate::services::graph_new_cache::DEFAULT_GPU_BYTES;
        use crate::services::graph_new_lod::{GraphDomain, SourcePoint};
        use crate::services::graph_new_renderer::GraphNewScene;
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU context");
        let mean = std::sync::Arc::new((0..2_000_000).map(|index|
            GroupedMeanPoint { group_code: 0, x: index as f64 / 1_999_999.0, y: 0.5 }).collect::<Vec<_>>());
        let (overlay, enabled_groups) = all_rows_overlay();
        let mut scene = GraphNewScene {
            presentation: Default::default(),
            width: 1280, height: 720, device_pixel_ratio: 1.0,
            domain: GraphDomain { x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
            points: (0..2_000_000).map(|index|
                SourcePoint::new(index + 1, index as f64 / 1_999_999.0, 0.25)).collect(),
            overlay,
            enabled_groups,
            mean: Some(mean.clone()),
        };
        let original = pollster::block_on(renderer.render_scene(&scene)).expect("2M with mean fits");
        let retained = renderer.cache_stats();
        scene.mean = None;
        pollster::block_on(renderer.render_scene(&scene)).expect("off without pressure");
        assert_eq!(renderer.cache_stats().allocated_bytes, retained.allocated_bytes);
        scene.mean = Some(mean.clone());
        let reused = pollster::block_on(renderer.render_scene(&scene)).expect("on reuses without pressure");
        assert_eq!(original.rgba, reused.rgba);
        assert_eq!(renderer.cache_stats().mean_geometry_uploads, 1);
        scene.points.extend((2_000_000..2_100_000).map(|index|
            SourcePoint::new(index + 1, (index - 2_000_000) as f64 / 99_999.0, 0.25)));
        assert!(renderer.planned_gpu_bytes(1280, 720, Some(&scene)).unwrap() > DEFAULT_GPU_BYTES);
        assert!(pollster::block_on(renderer.render_scene(&scene)).is_err(), "requested mean cannot be discarded to admit points");
        assert_eq!(renderer.cache_stats().allocated_bytes, retained.allocated_bytes);
        assert_eq!(renderer.cache_stats().geometry_uploads, 1);
        scene.mean = None;
        let planned = renderer.planned_gpu_bytes(1280, 720, Some(&scene)).unwrap();
        let released = (2_000_000 - 1) * 24 - 24;
        assert!(planned > DEFAULT_GPU_BYTES);
        assert!(planned - released <= DEFAULT_GPU_BYTES);
        let off = pollster::block_on(renderer.render_scene(&scene)).expect("inactive mean must not refuse feasible 2.1M scatter");
        assert!(!off.rgba.chunks_exact(4).any(|pixel| pixel == [220, 38, 38, 255]));
        assert_eq!(renderer.cache_stats().allocated_bytes, retained.allocated_bytes - released + 100_000 * 40);
        assert_eq!(renderer.cache_stats().geometry_uploads, 2);
        scene.mean = Some(mean);
        let on = pollster::block_on(renderer.render_scene(&scene)).expect("reclaimed line uploads again");
        assert_eq!(renderer.cache_stats().mean_geometry_uploads, 2);
        assert_eq!(renderer.cache_stats().geometry_uploads, 2, "points survive line reclamation");
        assert_eq!(renderer.cache_stats().allocated_bytes, retained.allocated_bytes + 100_000 * 40);
        let midpoint = (352 * 1280 + 672) * 4;
        assert_eq!(&on.rgba[midpoint..midpoint + 4], &[220, 38, 38, 255]);
        assert_eq!(on.rgba, original.rgba, "same line and scatter locations after reupload");
    }

    #[test]
    fn graph_new_review_raw_inactive_pressure_reentry() {
        use crate::services::graph_new_lod::{GraphDomain, SourcePoint};
        use crate::services::graph_new_renderer::GraphNewScene;
        for show_points in [false, true] {
            let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).unwrap();
            let indices = std::sync::Arc::new((0..1_999_999).map(|index| GroupedLineSegment {
                indices: [index, index + 1],
                group_code: 0,
            }).collect::<Vec<_>>());
            let (overlay, enabled_groups) = all_rows_overlay();
            let mut scene = GraphNewScene {
                presentation: super::super::graph_new_renderer::ScenePresentation { raw_line: Some(indices.clone()), show_points, x_axis: None },
                width: 1920, height: 1080, device_pixel_ratio: 1.0,
                domain: GraphDomain { x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
                points: (0..2_000_000).map(|index| SourcePoint::new(index + 1, index as f64 / 1_999_999.0, 0.5)).collect(),
                overlay,
                enabled_groups,
                mean: Some(std::sync::Arc::new(vec![
                    GroupedMeanPoint { group_code: 0, x: 0.0, y: 0.25 },
                    GroupedMeanPoint { group_code: 0, x: 1.0, y: 0.75 },
                ])),
            };
            let before = pollster::block_on(renderer.render_scene(&scene)).unwrap();
            let capacity = renderer.cache_stats().geometry_capacity_bytes;
            let uploads = renderer.cache_stats().geometry_uploads;
            scene.presentation.raw_line = None;
            scene.presentation.show_points = true;
            pollster::block_on(renderer.render_scene(&scene)).unwrap();
            let toggled_capacity = renderer.cache_stats().geometry_capacity_bytes;
            assert_eq!(
                toggled_capacity,
                capacity,
                "normal toggle keeps hidden point backing and raw indices resident without pressure"
            );
            scene.points.extend((2_000_000..2_100_000).map(|index| SourcePoint::new(index + 1, (index - 2_000_000) as f64 / 99_999.0, 0.5)));
            assert!(renderer.planned_gpu_bytes(1920, 1080, Some(&scene)).unwrap() > super::super::graph_new_cache::DEFAULT_GPU_BYTES);
            pollster::block_on(renderer.render_scene(&scene)).expect("inactive raw storage must be reclaimed under pressure");
            assert!(renderer.cache_stats().geometry_capacity_bytes < toggled_capacity + 100_000 * 40);
            scene.presentation.raw_line = Some(indices);
            scene.presentation.show_points = show_points;
            let restored = pollster::block_on(renderer.render_scene(&scene)).unwrap();
            assert_eq!(restored.rgba, before.rgba, "re-enabled raw indices remain valid");
            assert_eq!(renderer.cache_stats().geometry_uploads, uploads + 1);
        }
    }

    #[test]
    fn graph_new_grouped_raw_line_mode_skips_hidden_point_upload_budget() {
        use crate::services::graph_new_lod::{GraphDomain, SourcePoint};
        use crate::services::graph_new_renderer::GraphNewScene;

        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).unwrap();
        let indices = std::sync::Arc::new(
            (0..1_999_999)
                .map(|index| GroupedLineSegment {
                    indices: [index, index + 1],
                    group_code: 0,
                })
                .collect::<Vec<_>>(),
        );
        let (overlay, enabled_groups) = grouped_overlay(2_000_000);
        let scene = GraphNewScene {
            presentation: super::super::graph_new_renderer::ScenePresentation {
                raw_line: Some(indices),
                show_points: false,
                x_axis: None,
            },
            width: 1920,
            height: 1080,
            device_pixel_ratio: 1.0,
            domain: GraphDomain {
                x_min: 0.0,
                x_max: 1.0,
                y_min: 0.0,
                y_max: 1.0,
            },
            points: (0..2_000_000)
                .map(|index| SourcePoint::with_group(index + 1, index as f64 / 1_999_999.0, 0.5, 0))
                .collect(),
            overlay,
            enabled_groups,
            mean: None,
        };

        let planned = renderer.planned_gpu_bytes(1920, 1080, Some(&scene)).unwrap();
        assert!(
            planned <= super::super::graph_new_cache::DEFAULT_GPU_BYTES,
            "grouped line-only render should fit budget, planned {planned}"
        );
        pollster::block_on(renderer.render_scene(&scene)).expect("line-only grouped raw render fits");
        assert_eq!(renderer.cache_stats().geometry_uploads, 0, "point buffer stays idle in line-only mode");
    }

    #[test]
    fn graph_new_mean_gpu_budget_includes_uploads_and_replacement_buffers() {
        use crate::services::graph_new_lod::{GraphDomain, SourcePoint};
        use crate::services::graph_new_renderer::GraphNewScene;
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU context");
        let (overlay, enabled_groups) = all_rows_overlay();
        let mut scene = GraphNewScene {
            presentation: Default::default(),
            width: 240, height: 160, device_pixel_ratio: 1.0,
            domain: GraphDomain { x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0 },
            points: vec![SourcePoint::new(1, 0.5, 0.5); 100],
            overlay,
            enabled_groups,
            mean: Some(std::sync::Arc::new(vec![
                GroupedMeanPoint { group_code: 0, x: 0.0, y: 0.0 },
                GroupedMeanPoint { group_code: 0, x: 1.0, y: 1.0 },
            ])),
        };
        let target = 240 * 160 * 4 + u64::from(padded_bytes_per_row(240).unwrap()) * 160;
        assert!(renderer.planned_gpu_bytes(240, 160, Some(&scene)).unwrap() >= 2 * (100 * 40 + 24) + target);
        pollster::block_on(renderer.render_scene(&scene)).expect("first scene");
        let retained = renderer.cache_stats().allocated_bytes;
        scene.points.resize(1000, SourcePoint::new(2, 0.5, 0.5));
        scene.mean = Some(std::sync::Arc::new(
            std::iter::repeat(GroupedMeanPoint { group_code: 0, x: 0.5, y: 0.5 })
                .take(1000)
                .collect(),
        ));
        assert!(renderer.planned_gpu_bytes(240, 160, Some(&scene)).unwrap()
            >= retained + 2 * (1000 * 40 + 999 * 24));
        assert!(renderer.planned_gpu_bytes(480, 320, Some(&scene)).unwrap()
            >= renderer.planned_gpu_bytes(240, 160, Some(&scene)).unwrap() + 480 * 320 * 8);
    }

    #[test]
    fn scene_and_probe_share_target_without_changing_probe_pixels() {
        use crate::services::graph_new_lod::GraphDomain;
        use crate::services::graph_new_renderer::GraphNewScene;

        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU context");
        let before = pollster::block_on(renderer.render(240, 160)).expect("probe before scene");
        let (overlay, enabled_groups) = all_rows_overlay();
        let scene = GraphNewScene {
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
            overlay,
            enabled_groups,
            mean: None,
        };
        let first = pollster::block_on(renderer.render_scene(&scene)).expect("first scene");
        let second = pollster::block_on(renderer.render_scene(&scene)).expect("second scene");
        let after = pollster::block_on(renderer.render(240, 160)).expect("probe after scene");
        assert_eq!(renderer.target_allocations, 1);
        assert_eq!(before.rgba, after.rgba);
        assert_eq!(first.rgba, second.rgba);
        assert_ne!(before.rgba, first.rgba);
    }

    #[test]
    fn probe_sends_ordered_raw_frames_with_bounded_transport_state() {
        let request = GraphNewTransportProbeRequest::rgba8("probe", 64, 32, 1);
        let mut sink = CollectingFrameSink::default();

        let completion = GraphNewTransportService::new()
            .probe_with_sink(&request, &mut sink)
            .expect("probe must complete");

        assert_eq!(sink.headers.len(), 1);
        assert!(sink
            .headers
            .iter()
            .all(|header| header.readback_completed_at_unix_micros > 0));
        assert_eq!(
            sink.headers
                .iter()
                .map(|header| header.frame_id)
                .collect::<Vec<_>>(),
            [1]
        );
        assert_eq!(sink.payloads.len(), 1);
        assert_eq!(sink.send_order, ["header", "payload"]);
        assert!(sink
            .payloads
            .iter()
            .all(|payload| payload.len() == 64 * 32 * 4));
        assert_eq!(completion.frames_requested, 1);
        assert_eq!(completion.frames_sent, 1);
        assert_eq!(completion.dropped_superseded_frames, 0);
        assert_eq!(completion.peak_transport_bytes, 64 * 32 * 4);
        assert_eq!(completion.maximum_queue_depth, 1);
        assert_eq!(completion.render_ms.len(), 1);
        assert_eq!(completion.readback_ms.len(), 1);
    }

    #[test]
    fn probe_rejects_png_before_rendering() {
        let mut request = GraphNewTransportProbeRequest::rgba8("probe", 64, 32, 1);
        request.format = GraphNewFrameFormat::Png;
        let mut sink = CollectingFrameSink::default();

        let error = GraphNewTransportService::new()
            .probe_with_sink(&request, &mut sink)
            .expect_err("PNG is outside the Slice 0 transport contract");

        assert!(error.to_string().contains("RGBA8"));
        assert!(sink.send_order.is_empty());
    }

    #[test]
    fn probe_stops_when_the_frame_channel_closes() {
        let request = GraphNewTransportProbeRequest::rgba8("probe", 64, 32, 1);
        let mut sink = ClosingFrameSink::default();

        let error = GraphNewTransportService::new()
            .probe_with_sink(&request, &mut sink)
            .expect_err("closed channel must cancel the remaining probe frames");

        assert!(error.to_string().contains("channel closed"));
        assert_eq!(sink.send_calls, 2);
    }

    #[test]
    fn superseded_frame_is_dropped_before_channel_send() {
        let request = GraphNewTransportProbeRequest::rgba8("probe", 64, 32, 1);
        let mut sink = CollectingFrameSink::default();
        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new())
            .expect("test adapter must create a renderer");
        let generation_checks = Cell::new(0);

        let completion = GraphNewTransportService::new()
            .probe_with_renderer(&request, &mut sink, &mut renderer, || {
                let check = generation_checks.get();
                generation_checks.set(check + 1);
                check == 0
            })
            .expect("superseded probe must finish cleanly");

        assert!(sink.send_order.is_empty());
        assert_eq!(completion.frames_sent, 0);
        assert_eq!(completion.dropped_superseded_frames, 1);
        assert_eq!(completion.peak_transport_bytes, 0);
        assert_eq!(completion.maximum_queue_depth, 1);
    }
}
