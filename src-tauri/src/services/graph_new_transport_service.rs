use super::graph_new_renderer::{GraphNewScene, ScenePipeline};
use crate::error::AppError;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

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
        if renderer_guard.is_none() {
            *renderer_guard = Some(pollster::block_on(SyntheticFrameRenderer::new())?);
        }
        let Some(renderer) = renderer_guard.as_mut() else {
            return Err(AppError::Stats(
                "graph-new session renderer unavailable".to_owned(),
            ));
        };
        self.probe_with_renderer(request, &mut sink, renderer, || {
            latest_probe_generation().load(Ordering::Acquire) == generation
        })
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

    fn probe_with_renderer(
        &self,
        request: &GraphNewTransportProbeRequest,
        sink: &mut impl FrameSink,
        renderer: &mut SyntheticFrameRenderer,
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
            let frame = pollster::block_on(renderer.render(request.width, request.height))?;
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

pub(crate) struct SyntheticFrameRenderer {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    scene_pipeline: Option<ScenePipeline>,
    target: Option<ReadbackTarget>,
    #[cfg(test)]
    target_allocations: u32,
}

impl SyntheticFrameRenderer {
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

    async fn render_frame(
        &mut self,
        width: u32,
        height: u32,
        scene: Option<&GraphNewScene>,
    ) -> Result<SyntheticFrame, AppError> {
        let render_started = Instant::now();
        let target_bytes = u64::from(width) * u64::from(height) * 4 + u64::from(padded_bytes_per_row(width)?) * u64::from(height);
        let geometry_bytes = scene.map_or(0, |scene| (scene.points.len() as u64 + 1024) * 40 + 32
            + u64::from(super::graph_new_text::ATLAS_WIDTH) * u64::from(super::graph_new_text::ATLAS_HEIGHT));
        super::graph_new_renderer::check_gpu_budget(self.cache_stats().allocated_bytes.max(geometry_bytes), target_bytes,
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
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|_| AppError::Stats("graph-new GPU readback poll failed".to_owned()))?;
        receiver
            .recv()
            .map_err(|_| AppError::Stats("graph-new GPU readback callback closed".to_owned()))?
            .map_err(|_| AppError::Stats("graph-new GPU readback failed".to_owned()))?;
        let mapped = slice
            .get_mapped_range()
            .map_err(|_| AppError::Stats("graph-new GPU mapped range unavailable".to_owned()))?;
        let unpadded_bytes_per_row = usize::try_from(width)
            .ok()
            .and_then(|value| value.checked_mul(RGBA8_BYTES_PER_PIXEL as usize))
            .ok_or_else(|| AppError::InvalidParam("graph-new row size overflow".to_owned()))?;
        let output_capacity = unpadded_bytes_per_row
            .checked_mul(height as usize)
            .ok_or_else(|| AppError::InvalidParam("graph-new frame size overflow".to_owned()))?;
        let mut rgba = Vec::with_capacity(output_capacity);
        for row in mapped.chunks_exact(padded_bytes_per_row as usize) {
            rgba.extend_from_slice(&row[..unpadded_bytes_per_row]);
        }
        drop(mapped);
        target.staging.unmap();
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
    fn scene_and_probe_share_target_without_changing_probe_pixels() {
        use crate::services::graph_new_lod::GraphDomain;
        use crate::services::graph_new_renderer::GraphNewScene;

        let mut renderer = pollster::block_on(SyntheticFrameRenderer::new()).expect("GPU context");
        let before = pollster::block_on(renderer.render(240, 160)).expect("probe before scene");
        let scene = GraphNewScene {
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
