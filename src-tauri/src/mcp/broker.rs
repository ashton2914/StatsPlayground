use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, Notify, OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::error::AppError;
use crate::models::mcp::{
    ApplicationCommandCancelEvent, ApplicationCommandEnvelope, ApplicationCommandProgress,
    ApplicationCommandRequestEvent, ApplicationCommandResponse, ApplicationCommandStatus,
    McpBrokerCompletion, McpCommandBrokerConfig, McpCommandError, McpCommandResponse,
};

const APPLICATION_COMMAND_REQUEST_EVENT: &str = "application-command-request";
const APPLICATION_COMMAND_CANCEL_EVENT: &str = "application-command-cancel";

pub trait ApplicationCommandEventEmitter: Clone + Send + Sync + 'static {
    fn emit_application_command_request(
        &self,
        event: ApplicationCommandRequestEvent,
    ) -> Result<(), AppError>;

    fn emit_application_command_cancel(&self, request_id: String) -> Result<(), AppError>;
}

#[derive(Clone, Default)]
pub struct TauriApplicationCommandEventEmitter {
    app_handle: Arc<Mutex<Option<AppHandle>>>,
}

impl TauriApplicationCommandEventEmitter {
    pub fn set_app_handle(&self, app_handle: AppHandle) -> Result<(), AppError> {
        let mut current = self
            .app_handle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        *current = Some(app_handle);
        Ok(())
    }
}

impl ApplicationCommandEventEmitter for TauriApplicationCommandEventEmitter {
    fn emit_application_command_request(
        &self,
        event: ApplicationCommandRequestEvent,
    ) -> Result<(), AppError> {
        let app_handle = self
            .app_handle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .clone()
            .ok_or_else(|| AppError::Busy("Application command bridge is not ready".to_string()))?;
        app_handle
            .emit(APPLICATION_COMMAND_REQUEST_EVENT, event)
            .map_err(|error| AppError::InvalidParam(error.to_string()))
    }

    fn emit_application_command_cancel(&self, request_id: String) -> Result<(), AppError> {
        let app_handle = self
            .app_handle
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .clone()
            .ok_or_else(|| AppError::Busy("Application command bridge is not ready".to_string()))?;
        app_handle
            .emit(
                APPLICATION_COMMAND_CANCEL_EVENT,
                ApplicationCommandCancelEvent { request_id },
            )
            .map_err(|error| AppError::InvalidParam(error.to_string()))
    }
}

#[derive(Clone)]
pub struct McpCancellationToken {
    inner: Arc<CancellationInner>,
}

struct CancellationInner {
    cancelled: AtomicBool,
    notify: Notify,
}

impl McpCancellationToken {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(CancellationInner {
                cancelled: AtomicBool::new(false),
                notify: Notify::new(),
            }),
        }
    }

    pub fn cancel(&self) {
        if !self.inner.cancelled.swap(true, Ordering::SeqCst) {
            self.inner.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.inner.notify.notified().await;
    }
}

impl Default for McpCancellationToken {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub struct McpCommandBroker<E: ApplicationCommandEventEmitter = TauriApplicationCommandEventEmitter>
{
    inner: Arc<BrokerInner<E>>,
}

struct BrokerInner<E: ApplicationCommandEventEmitter> {
    emitter: E,
    ready: AtomicBool,
    pending: Mutex<HashMap<String, PendingEntry>>,
    committed_outcomes: Mutex<CommittedOutcomes>,
    semaphore: Arc<Semaphore>,
    config: McpCommandBrokerConfig,
}

struct CommittedOutcomes {
    responses: HashMap<String, ApplicationCommandResponse>,
    order: VecDeque<String>,
}

struct PendingEntry {
    completion: Option<oneshot::Sender<ApplicationCommandResponse>>,
    progress_sender: mpsc::UnboundedSender<ApplicationCommandProgress>,
    cancellation_token: McpCancellationToken,
    committing: bool,
    retain_committed_outcome: bool,
}

impl McpCommandBroker<TauriApplicationCommandEventEmitter> {
    pub fn new() -> Self {
        Self::with_emitter(
            TauriApplicationCommandEventEmitter::default(),
            McpCommandBrokerConfig::default(),
        )
    }

    pub fn set_app_handle(&self, app_handle: AppHandle) -> Result<(), AppError> {
        self.inner.emitter.set_app_handle(app_handle)
    }
}

impl Default for McpCommandBroker<TauriApplicationCommandEventEmitter> {
    fn default() -> Self {
        Self::new()
    }
}

impl<E: ApplicationCommandEventEmitter> McpCommandBroker<E> {
    pub fn with_emitter(emitter: E, config: McpCommandBrokerConfig) -> Self {
        let max_concurrent = config.max_concurrent.max(1);
        Self {
            inner: Arc::new(BrokerInner {
                emitter,
                ready: AtomicBool::new(false),
                pending: Mutex::new(HashMap::new()),
                committed_outcomes: Mutex::new(CommittedOutcomes {
                    responses: HashMap::new(),
                    order: VecDeque::new(),
                }),
                semaphore: Arc::new(Semaphore::new(max_concurrent)),
                config: McpCommandBrokerConfig {
                    max_pending: config.max_pending.max(1),
                    max_concurrent,
                    max_committed_outcomes: config.max_committed_outcomes.max(1),
                    commit_grace_timeout_ms: config.commit_grace_timeout_ms.max(1),
                },
            }),
        }
    }

    #[cfg(test)]
    pub fn new_for_tests(emitter: E, config: McpCommandBrokerConfig) -> Self {
        Self::with_emitter(emitter, config)
    }

    pub fn register_dispatcher(&self) -> Result<(), AppError> {
        self.inner.ready.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn unregister_dispatcher(&self) -> Result<(), AppError> {
        self.inner.ready.store(false, Ordering::SeqCst);
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let request_ids: Vec<String> = pending.keys().cloned().collect();
        for request_id in request_ids {
            let should_remove = if let Some(entry) = pending.get_mut(&request_id) {
                if entry.committing {
                    entry.retain_committed_outcome = true;
                    false
                } else {
                    entry.cancellation_token.cancel();
                    if let Some(sender) = entry.completion.take() {
                        let _ = sender.send(ApplicationCommandResponse::Error(McpCommandError {
                            code: "cancelled".to_string(),
                            message: "Application command dispatcher unregistered".to_string(),
                            retryable: true,
                            details: None,
                        }));
                    }
                    true
                }
            } else {
                false
            };
            if should_remove {
                pending.remove(&request_id);
            }
        }
        Ok(())
    }

    pub fn cancel_non_committing_requests(&self, message: &str) -> Result<(), AppError> {
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let request_ids: Vec<String> = pending
            .iter()
            .filter(|(_, entry)| !entry.committing)
            .map(|(request_id, _)| request_id.clone())
            .collect();
        for request_id in request_ids {
            if let Some(mut entry) = pending.remove(&request_id) {
                if let Some(sender) = entry.completion.take() {
                    let _ = sender.send(ApplicationCommandResponse::Error(McpCommandError {
                        code: "cancelled".to_string(),
                        message: message.to_string(),
                        retryable: true,
                        details: None,
                    }));
                }
                self.inner
                    .emitter
                    .emit_application_command_cancel(request_id)?;
            }
        }
        Ok(())
    }

    pub fn queue_status(&self) -> Result<(usize, usize), AppError> {
        let pending = self
            .inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let running = self
            .inner
            .config
            .max_concurrent
            .saturating_sub(self.inner.semaphore.available_permits());
        let queued = pending.len().saturating_sub(running);
        Ok((queued, running))
    }

    pub async fn dispatch(
        &self,
        command: ApplicationCommandEnvelope,
        timeout: Duration,
        progress_sender: mpsc::UnboundedSender<ApplicationCommandProgress>,
        cancellation_token: McpCancellationToken,
    ) -> Result<McpCommandResponse, AppError> {
        if !self.inner.ready.load(Ordering::SeqCst) {
            return Err(AppError::Busy(
                "Application command bridge is not ready".to_string(),
            ));
        }
        reject_absolute_paths(&command.input)?;
        if let Some(control) = &command.control {
            reject_absolute_paths(control)?;
        }
        let deadline = tokio::time::Instant::now() + timeout;

        let request_id = format!("mcp-{}", Uuid::new_v4());
        let (completion_tx, completion_rx) = oneshot::channel();
        self.insert_pending(
            request_id.clone(),
            PendingEntry {
                completion: Some(completion_tx),
                progress_sender,
                cancellation_token: cancellation_token.clone(),
                committing: false,
                retain_committed_outcome: false,
            },
        )?;

        let permit = self
            .acquire_slot(&request_id, &cancellation_token, deadline)
            .await?;

        let event = ApplicationCommandRequestEvent {
            request_id: request_id.clone(),
            command,
        };
        if let Err(error) = self.inner.emitter.emit_application_command_request(event) {
            self.remove_pending(&request_id)?;
            drop(permit);
            return Err(error);
        }

        self.await_completion(
            request_id,
            completion_rx,
            cancellation_token,
            deadline,
            permit,
        )
        .await
    }

    pub fn record_progress(&self, progress: ApplicationCommandProgress) -> Result<bool, AppError> {
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let Some(entry) = pending.get_mut(&progress.request_id) else {
            return Ok(false);
        };
        if progress.status == ApplicationCommandStatus::Committing {
            entry.committing = true;
        }
        entry
            .progress_sender
            .send(progress)
            .map_err(|error| AppError::FileIO(error.to_string()))?;
        Ok(true)
    }

    pub fn complete_application_command(
        &self,
        completion: McpBrokerCompletion,
    ) -> Result<bool, AppError> {
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let Some(mut entry) = pending.remove(&completion.request_id) else {
            return self.update_retained_outcome(completion.request_id, completion.response);
        };
        let request_id = completion.request_id.clone();
        if entry.retain_committed_outcome {
            self.retain_committed_outcome(request_id, completion.response.clone())?;
        }
        if let Some(sender) = entry.completion.take() {
            sender.send(completion.response).map_err(|_| {
                AppError::FileIO("Application command response channel closed".to_string())
            })?;
        }
        Ok(true)
    }

    fn update_retained_outcome(
        &self,
        request_id: String,
        response: ApplicationCommandResponse,
    ) -> Result<bool, AppError> {
        let mut outcomes = self
            .inner
            .committed_outcomes
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        if !outcomes.responses.contains_key(&request_id) {
            return Ok(false);
        }
        outcomes.responses.insert(request_id, response);
        Ok(true)
    }

    pub fn cancellation_requested(&self, request_id: &str) -> Result<bool, AppError> {
        let pending = self
            .inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        Ok(pending
            .get(request_id)
            .map(|entry| entry.cancellation_token.is_cancelled())
            .unwrap_or(false))
    }

    pub fn committed_outcome(
        &self,
        request_id: &str,
    ) -> Result<Option<ApplicationCommandResponse>, AppError> {
        self.inner
            .committed_outcomes
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))
            .map(|outcomes| outcomes.responses.get(request_id).cloned())
    }

    fn retain_committed_outcome(
        &self,
        request_id: String,
        response: ApplicationCommandResponse,
    ) -> Result<(), AppError> {
        let mut outcomes = self
            .inner
            .committed_outcomes
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        if !outcomes.responses.contains_key(&request_id) {
            outcomes.order.push_back(request_id.clone());
        }
        outcomes.responses.insert(request_id, response);
        while outcomes.order.len() > self.inner.config.max_committed_outcomes {
            if let Some(evicted) = outcomes.order.pop_front() {
                outcomes.responses.remove(&evicted);
            }
        }
        Ok(())
    }

    async fn acquire_slot(
        &self,
        request_id: &str,
        cancellation_token: &McpCancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<OwnedSemaphorePermit, AppError> {
        tokio::select! {
            biased;
            _ = tokio::time::sleep_until(deadline) => {
                self.remove_pending(request_id)?;
                Err(AppError::Busy("Application command timeout".to_string()))
            }
            _ = cancellation_token.cancelled() => {
                self.remove_pending(request_id)?;
                Err(AppError::Cancelled("Application command cancelled".to_string()))
            }
            permit = self.inner.semaphore.clone().acquire_owned() => {
                let permit = permit.map_err(|error| AppError::Busy(error.to_string()))?;
                if tokio::time::Instant::now() >= deadline {
                    drop(permit);
                    self.remove_pending(request_id)?;
                    return Err(AppError::Busy("Application command timeout".to_string()));
                }
                Ok(permit)
            }
        }
    }

    fn insert_pending(&self, request_id: String, entry: PendingEntry) -> Result<(), AppError> {
        let mut pending = self
            .inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        if pending.len() >= self.inner.config.max_pending {
            return Err(AppError::Busy(
                "Application command queue is full".to_string(),
            ));
        }
        pending.insert(request_id, entry);
        Ok(())
    }

    fn remove_pending(&self, request_id: &str) -> Result<Option<PendingEntry>, AppError> {
        self.inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))
            .map(|mut pending| pending.remove(request_id))
    }

    async fn await_completion(
        &self,
        request_id: String,
        completion_rx: oneshot::Receiver<ApplicationCommandResponse>,
        cancellation_token: McpCancellationToken,
        deadline: tokio::time::Instant,
        permit: OwnedSemaphorePermit,
    ) -> Result<McpCommandResponse, AppError> {
        let mut completion_rx = completion_rx;
        let mut cancellation_forwarded = false;
        let mut timeout_elapsed = false;
        let commit_grace_timeout = Duration::from_millis(self.inner.config.commit_grace_timeout_ms);
        let result = loop {
            tokio::select! {
                response = &mut completion_rx => break self.response_to_result(request_id.clone(), response),
                _ = cancellation_token.cancelled(), if !cancellation_forwarded => {
                    cancellation_forwarded = true;
                    if self.forward_cancellation(&request_id)? {
                        continue;
                    }
                    break Err(AppError::Cancelled("Application command cancelled".to_string()));
                }
                _ = tokio::time::sleep_until(deadline), if !timeout_elapsed && !cancellation_forwarded => {
                    timeout_elapsed = true;
                    if self.mark_timeout_elapsed(&request_id)? {
                        continue;
                    }
                    break Err(AppError::Busy("Application command timeout".to_string()));
                }
                _ = tokio::time::sleep(commit_grace_timeout), if timeout_elapsed || cancellation_forwarded => {
                    break self.record_uncertain_outcome(&request_id);
                }
            }
        };
        drop(permit);
        result
    }

    fn record_uncertain_outcome(&self, request_id: &str) -> Result<McpCommandResponse, AppError> {
        let removed = self.remove_pending(request_id)?;
        if removed.is_some() {
            self.retain_committed_outcome(
                request_id.to_string(),
                ApplicationCommandResponse::Error(Self::uncertain_outcome_error(request_id)),
            )?;
        }
        Err(AppError::ApplicationCommand(Self::uncertain_outcome_error(
            request_id,
        )))
    }

    fn uncertain_outcome_error(request_id: &str) -> McpCommandError {
        McpCommandError {
            code: "outcome_uncertain".to_string(),
            message:
                "Application command commit outcome is uncertain; the commit may have occurred"
                    .to_string(),
            retryable: true,
            details: Some(json!({ "requestId": request_id })),
        }
    }

    fn response_to_result(
        &self,
        request_id: String,
        response: Result<ApplicationCommandResponse, oneshot::error::RecvError>,
    ) -> Result<McpCommandResponse, AppError> {
        match response.map_err(|error| AppError::FileIO(error.to_string()))? {
            ApplicationCommandResponse::Success(result) => {
                Ok(McpCommandResponse::from_result(request_id, result))
            }
            ApplicationCommandResponse::Error(error) if error.code == "cancelled" => {
                Err(AppError::Cancelled(error.message))
            }
            ApplicationCommandResponse::Error(error) => Err(AppError::ApplicationCommand(error)),
        }
    }

    fn forward_cancellation(&self, request_id: &str) -> Result<bool, AppError> {
        let should_wait = {
            let mut pending = self
                .inner
                .pending
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let Some(entry) = pending.get_mut(request_id) else {
                return Ok(false);
            };
            if entry.committing {
                entry.retain_committed_outcome = true;
                true
            } else {
                entry.cancellation_token.cancel();
                pending.remove(request_id);
                false
            }
        };
        self.inner
            .emitter
            .emit_application_command_cancel(request_id.to_string())?;
        Ok(should_wait)
    }

    fn mark_timeout_elapsed(&self, request_id: &str) -> Result<bool, AppError> {
        let should_wait = {
            let mut pending = self
                .inner
                .pending
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let Some(entry) = pending.get_mut(request_id) else {
                return Ok(false);
            };
            if entry.committing {
                entry.retain_committed_outcome = true;
                true
            } else {
                entry.cancellation_token.cancel();
                pending.remove(request_id);
                false
            }
        };
        if !should_wait {
            self.inner
                .emitter
                .emit_application_command_cancel(request_id.to_string())?;
        }
        Ok(should_wait)
    }
}

fn reject_absolute_paths(value: &Value) -> Result<(), AppError> {
    match value {
        Value::String(text) if looks_like_absolute_path(text) => Err(AppError::InvalidParam(
            "Application command payload must not contain absolute paths".to_string(),
        )),
        Value::Array(values) => {
            for value in values {
                reject_absolute_paths(value)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (key, value) in values {
                if looks_like_absolute_path(key) {
                    return Err(AppError::InvalidParam(
                        "Application command payload must not contain absolute paths".to_string(),
                    ));
                }
                reject_absolute_paths(value)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn looks_like_absolute_path(text: &str) -> bool {
    text.starts_with('/')
        || text.starts_with('~')
        || text.starts_with("\\\\")
        || text.get(1..3) == Some(":\\")
        || text.get(1..3) == Some(":/")
}

pub fn configure_tauri_broker(app: &tauri::App) -> Result<(), AppError> {
    let state = app.state::<crate::state::AppState>();
    state
        .mcp_command_broker
        .set_app_handle(app.handle().clone())
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::mpsc;

    use super::*;
    use crate::models::mcp::{
        ApplicationCommandEnvelope, ApplicationCommandProgress, ApplicationCommandRequestEvent,
        ApplicationCommandResponse, ApplicationCommandStatus, McpBrokerCompletion,
        McpCommandBrokerConfig, McpCommandError, McpCommandResult,
    };

    #[derive(Clone, Default)]
    struct RecordingEmitter {
        events: Arc<Mutex<Vec<ApplicationCommandRequestEvent>>>,
        cancellations: Arc<Mutex<Vec<String>>>,
    }

    impl RecordingEmitter {
        fn requests(&self) -> Vec<ApplicationCommandRequestEvent> {
            self.events.lock().expect("test emitter lock").clone()
        }

        fn cancellation_requests(&self) -> Vec<String> {
            self.cancellations
                .lock()
                .expect("test cancellation emitter lock")
                .clone()
        }
    }

    impl ApplicationCommandEventEmitter for RecordingEmitter {
        fn emit_application_command_request(
            &self,
            event: ApplicationCommandRequestEvent,
        ) -> Result<(), crate::error::AppError> {
            self.events.lock().expect("test emitter lock").push(event);
            Ok(())
        }

        fn emit_application_command_cancel(
            &self,
            request_id: String,
        ) -> Result<(), crate::error::AppError> {
            self.cancellations
                .lock()
                .expect("test cancellation emitter lock")
                .push(request_id);
            Ok(())
        }
    }

    fn test_command(marker: &str) -> ApplicationCommandEnvelope {
        ApplicationCommandEnvelope {
            command_type: "project.inspect".to_string(),
            input: json!({ "marker": marker }),
            control: None,
        }
    }

    fn broker(
        max_pending: usize,
        max_concurrent: usize,
    ) -> (McpCommandBroker<RecordingEmitter>, RecordingEmitter) {
        let emitter = RecordingEmitter::default();
        let broker = McpCommandBroker::new_for_tests(
            emitter.clone(),
            McpCommandBrokerConfig {
                max_pending,
                max_concurrent,
                ..McpCommandBrokerConfig::default()
            },
        );
        (broker, emitter)
    }

    fn broker_with_config(
        config: McpCommandBrokerConfig,
    ) -> (McpCommandBroker<RecordingEmitter>, RecordingEmitter) {
        let emitter = RecordingEmitter::default();
        let broker = McpCommandBroker::new_for_tests(emitter.clone(), config);
        (broker, emitter)
    }

    fn pending_count<E: ApplicationCommandEventEmitter>(broker: &McpCommandBroker<E>) -> usize {
        broker.inner.pending.lock().expect("pending lock").len()
    }

    fn noop_raw_waker() -> RawWaker {
        fn clone(_: *const ()) -> RawWaker {
            noop_raw_waker()
        }
        fn wake(_: *const ()) {}
        fn wake_by_ref(_: *const ()) {}
        fn drop(_: *const ()) {}
        static VTABLE: RawWakerVTable = RawWakerVTable::new(clone, wake, wake_by_ref, drop);
        RawWaker::new(std::ptr::null(), &VTABLE)
    }

    fn poll_once<F: Future>(future: Pin<&mut F>) -> Poll<F::Output> {
        let waker = unsafe { Waker::from_raw(noop_raw_waker()) };
        let mut context = Context::from_waker(&waker);
        future.poll(&mut context)
    }

    #[tokio::test]
    async fn dispatch_rejects_when_frontend_dispatcher_is_not_ready() {
        let (broker, _emitter) = broker(2, 1);
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
        let token = McpCancellationToken::new();

        let result = broker
            .dispatch(
                test_command("not-ready"),
                Duration::from_millis(20),
                progress_tx,
                token,
            )
            .await;

        assert!(
            matches!(result, Err(crate::error::AppError::Busy(message)) if message.contains("not ready"))
        );
    }

    #[tokio::test]
    async fn dispatch_bounds_pending_entries_and_preserves_request_event_correlation() {
        let (broker, emitter) = broker(1, 1);
        broker.register_dispatcher().expect("register dispatcher");
        let (first_progress_tx, _first_progress_rx) = mpsc::unbounded_channel();
        let first_token = McpCancellationToken::new();

        let first = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("first"),
                        Duration::from_secs(5),
                        first_progress_tx,
                        first_token,
                    )
                    .await
            }
        });

        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }

        let (second_progress_tx, _second_progress_rx) = mpsc::unbounded_channel();
        let second = broker
            .dispatch(
                test_command("second"),
                Duration::from_millis(20),
                second_progress_tx,
                McpCancellationToken::new(),
            )
            .await;
        assert!(
            matches!(second, Err(crate::error::AppError::Busy(message)) if message.contains("queue"))
        );

        let requests = emitter.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].command.command_type, "project.inspect");
        assert_eq!(requests[0].command.input, json!({ "marker": "first" }));

        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: requests[0].request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 4,
                    data: json!({ "ok": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete first request");

        let first_result = first.await.expect("dispatch task").expect("first result");
        assert_eq!(first_result.request_id, requests[0].request_id);
        assert_eq!(first_result.data, json!({ "ok": true }));
    }

    #[tokio::test]
    async fn progress_and_result_updates_are_accepted_only_for_the_matching_request() {
        let (broker, emitter) = broker(2, 2);
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();
        let token = McpCancellationToken::new();

        let pending = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("correlate"),
                        Duration::from_secs(5),
                        progress_tx,
                        token,
                    )
                    .await
            }
        });

        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let request_id = emitter.requests()[0].request_id.clone();

        assert!(matches!(
            broker.record_progress(ApplicationCommandProgress {
                request_id: "unknown".to_string(),
                status: ApplicationCommandStatus::Running,
                stage: "ignored".to_string(),
                message: None,
                percent: None,
            }),
            Ok(false)
        ));
        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: "unknown".to_string(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 0,
                    data: json!({ "wrong": true }),
                    warnings: vec![],
                }),
            }),
            Ok(false)
        ));

        assert!(matches!(
            broker.record_progress(ApplicationCommandProgress {
                request_id: request_id.clone(),
                status: ApplicationCommandStatus::Running,
                stage: "load".to_string(),
                message: Some("Loading".to_string()),
                percent: Some(0.5),
            }),
            Ok(true)
        ));
        let progress = progress_rx.recv().await.expect("progress");
        assert_eq!(progress.request_id, request_id);
        assert_eq!(progress.stage, "load");

        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 8,
                    data: json!({ "matched": true }),
                    warnings: vec![],
                }),
            }),
            Ok(true)
        ));
        let response = pending.await.expect("dispatch task").expect("response");
        assert_eq!(response.request_id, request_id);
        assert_eq!(response.data, json!({ "matched": true }));

        assert!(matches!(
            broker.record_progress(ApplicationCommandProgress {
                request_id,
                status: ApplicationCommandStatus::Running,
                stage: "late".to_string(),
                message: None,
                percent: None,
            }),
            Ok(false)
        ));
    }

    #[tokio::test]
    async fn timeout_and_queued_cancellation_cleanup_pending_requests() {
        let (broker, emitter) = broker(1, 1);
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();

        let timeout_result = broker
            .dispatch(
                test_command("timeout"),
                Duration::from_millis(5),
                progress_tx,
                McpCancellationToken::new(),
            )
            .await;
        assert!(
            matches!(timeout_result, Err(crate::error::AppError::Busy(message)) if message.contains("timeout"))
        );
        let timed_out_request_id = emitter.requests()[0].request_id.clone();
        assert_eq!(
            emitter.cancellation_requests(),
            vec![timed_out_request_id.clone()]
        );
        assert!(matches!(
            broker.record_progress(ApplicationCommandProgress {
                request_id: timed_out_request_id.clone(),
                status: ApplicationCommandStatus::Running,
                stage: "late".to_string(),
                message: Some("late progress".to_string()),
                percent: Some(0.9),
            }),
            Ok(false)
        ));
        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: timed_out_request_id,
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 0,
                    data: json!({}),
                    warnings: vec![],
                }),
            }),
            Ok(false)
        ));

        let (cancel_progress_tx, _cancel_progress_rx) = mpsc::unbounded_channel();
        let cancel_token = McpCancellationToken::new();
        let queued = tokio::spawn({
            let broker = broker.clone();
            let token = cancel_token.clone();
            async move {
                broker
                    .dispatch(
                        test_command("cancel"),
                        Duration::from_secs(5),
                        cancel_progress_tx,
                        token,
                    )
                    .await
            }
        });
        while emitter.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
        let cancelled_request_id = emitter.requests()[1].request_id.clone();
        cancel_token.cancel();
        while emitter.cancellation_requests().is_empty() {
            tokio::task::yield_now().await;
        }
        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: cancelled_request_id,
                response: ApplicationCommandResponse::Error(McpCommandError {
                    code: "cancelled".to_string(),
                    message: "Command cancelled".to_string(),
                    retryable: false,
                    details: None,
                }),
            }),
            Ok(true)
        ));
        let cancelled = queued.await.expect("queued task");
        assert!(
            matches!(cancelled, Err(crate::error::AppError::Cancelled(message)) if message.contains("cancelled"))
        );
    }

    #[tokio::test]
    async fn queued_dispatch_timeout_covers_semaphore_wait_without_frontend_cancel_or_emit() {
        let (broker, emitter) = broker(2, 1);
        broker.register_dispatcher().expect("register dispatcher");
        let (first_progress_tx, _first_progress_rx) = mpsc::unbounded_channel();

        let first = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("holding-permit"),
                        Duration::from_secs(5),
                        first_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let first_request_id = emitter.requests()[0].request_id.clone();

        let (second_progress_tx, _second_progress_rx) = mpsc::unbounded_channel();
        let second = tokio::time::timeout(
            Duration::from_millis(100),
            broker.dispatch(
                test_command("queued-timeout"),
                Duration::from_millis(5),
                second_progress_tx,
                McpCancellationToken::new(),
            ),
        )
        .await
        .expect("queued timeout must be bounded by caller timeout");
        assert!(matches!(
            second,
            Err(crate::error::AppError::Busy(message)) if message.contains("timeout")
        ));
        assert_eq!(emitter.requests().len(), 1);
        assert_eq!(emitter.cancellation_requests(), Vec::<String>::new());

        let (third_progress_tx, _third_progress_rx) = mpsc::unbounded_channel();
        let third = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("capacity-reused"),
                        Duration::from_secs(5),
                        third_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });

        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: first_request_id,
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 12,
                    data: json!({ "first": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete holding request");
        first.await.expect("first task").expect("first result");

        while emitter.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
        let third_request = emitter.requests()[1].clone();
        assert_eq!(
            third_request.command.input,
            json!({ "marker": "capacity-reused" })
        );
        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: third_request.request_id,
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 13,
                    data: json!({ "third": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete reused-capacity request");
        third.await.expect("third task").expect("third result");
    }

    #[tokio::test(start_paused = true)]
    async fn queued_dispatch_deadline_wins_when_permit_and_timeout_are_ready_together() {
        let (broker, emitter) = broker(2, 1);
        broker.register_dispatcher().expect("register dispatcher");
        let (first_progress_tx, _first_progress_rx) = mpsc::unbounded_channel();

        let first = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("boundary-holder"),
                        Duration::from_secs(5),
                        first_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let first_request_id = emitter.requests()[0].request_id.clone();

        let (second_progress_tx, _second_progress_rx) = mpsc::unbounded_channel();
        let second_token = McpCancellationToken::new();
        let second = broker.dispatch(
            test_command("boundary-queued"),
            Duration::from_millis(30),
            second_progress_tx,
            second_token,
        );
        tokio::pin!(second);
        assert!(matches!(poll_once(second.as_mut()), Poll::Pending));
        assert_eq!(pending_count(&broker), 2);

        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: first_request_id,
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 20,
                    data: json!({ "first": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete boundary holder");
        first.await.expect("first task").expect("first result");
        assert_eq!(pending_count(&broker), 1);

        tokio::time::advance(Duration::from_millis(30)).await;
        let second_result = poll_once(second.as_mut());
        assert!(matches!(
            second_result,
            Poll::Ready(Err(crate::error::AppError::Busy(message))) if message.contains("timeout")
        ));
        assert_eq!(pending_count(&broker), 0);
        assert_eq!(emitter.requests().len(), 1);
        assert!(emitter.cancellation_requests().is_empty());

        let (third_progress_tx, _third_progress_rx) = mpsc::unbounded_channel();
        let third = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("capacity-reused-after-boundary-timeout"),
                        Duration::from_secs(5),
                        third_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
        let third_request = emitter.requests()[1].clone();
        assert_eq!(
            third_request.command.input,
            json!({ "marker": "capacity-reused-after-boundary-timeout" })
        );
        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: third_request.request_id,
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 22,
                    data: json!({ "third": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete reused-capacity request");
        third.await.expect("third task").expect("third result");
    }

    #[tokio::test]
    async fn running_cancellation_emits_correlated_frontend_cancel_and_ignores_late_precommit_outcome(
    ) {
        let (broker, emitter) = broker(2, 2);
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
        let token = McpCancellationToken::new();

        let running = tokio::spawn({
            let broker = broker.clone();
            let token = token.clone();
            async move {
                broker
                    .dispatch(
                        test_command("running"),
                        Duration::from_secs(5),
                        progress_tx,
                        token,
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let running_request_id = emitter.requests()[0].request_id.clone();
        token.cancel();
        while emitter.cancellation_requests().is_empty() {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            emitter.cancellation_requests(),
            vec![running_request_id.clone()]
        );
        assert!(matches!(
            broker.cancellation_requested(&running_request_id),
            Ok(false)
        ));
        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: running_request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: true,
                    project_revision: 3,
                    data: json!({ "committedAfterCancel": true }),
                    warnings: vec![],
                }),
            }),
            Ok(false)
        ));
        let cancelled = running.await.expect("running task");
        assert!(matches!(
            cancelled,
            Err(crate::error::AppError::Cancelled(message)) if message.contains("cancelled")
        ));
    }

    #[tokio::test]
    async fn server_shutdown_cancels_non_committing_requests_and_reports_queue_status() {
        let (broker, emitter) = broker(2, 1);
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();

        let pending = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("shutdown"),
                        Duration::from_secs(5),
                        progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let (queued, running) = broker.queue_status().expect("queue status");
        assert_eq!(queued, 0);
        assert_eq!(running, 1);

        broker
            .cancel_non_committing_requests("MCP server stopped")
            .expect("cancel pending requests");
        let request_id = emitter.requests()[0].request_id.clone();
        assert_eq!(emitter.cancellation_requests(), vec![request_id]);
        let (queued, running) = broker.queue_status().expect("queue status after cancel");
        assert_eq!(queued, 0);
        assert_eq!(running, 1);
        assert!(matches!(
            pending.await.expect("pending dispatch"),
            Err(crate::error::AppError::Cancelled(message)) if message.contains("stopped")
        ));
        let (queued, running) = broker.queue_status().expect("queue status after task");
        assert_eq!(queued, 0);
        assert_eq!(running, 0);
        assert!(matches!(
            broker.dispatch(
                test_command("still-ready"),
                Duration::from_millis(5),
                mpsc::unbounded_channel().0,
                McpCancellationToken::new(),
            ).await,
            Err(crate::error::AppError::Busy(message)) if message.contains("timeout")
        ));
    }

    #[tokio::test]
    async fn queue_status_distinguishes_running_from_queued_entries() {
        let (broker, emitter) = broker(4, 1);
        broker.register_dispatcher().expect("register dispatcher");

        let (first_progress_tx, _first_progress_rx) = mpsc::unbounded_channel();
        let first = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("running"),
                        Duration::from_secs(5),
                        first_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });

        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }

        let (queued_requests, running_requests) = broker.queue_status().expect("queue status");
        assert_eq!(queued_requests, 0);
        assert_eq!(running_requests, 1);

        let (second_progress_tx, _second_progress_rx) = mpsc::unbounded_channel();
        let second = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("queued"),
                        Duration::from_secs(5),
                        second_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });

        while pending_count(&broker) < 2 {
            tokio::task::yield_now().await;
        }

        let (queued_requests, running_requests) = broker.queue_status().expect("queue status");
        assert_eq!(queued_requests, 1);
        assert_eq!(running_requests, 1);

        let requests = emitter.requests();
        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: requests[0].request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 1,
                    data: json!({ "slot": 1 }),
                    warnings: vec![],
                }),
            })
            .expect("complete first request");

        while emitter.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
        let requests = emitter.requests();
        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: requests[1].request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 1,
                    data: json!({ "slot": 2 }),
                    warnings: vec![],
                }),
            })
            .expect("complete second request");

        first.await.expect("first join").expect("first success");
        second.await.expect("second join").expect("second success");
    }

    #[tokio::test]
    async fn unregister_dispatcher_preserves_committing_entries_and_late_outcomes() {
        let (broker, emitter) = broker_with_config(McpCommandBrokerConfig {
            max_pending: 2,
            max_concurrent: 1,
            max_committed_outcomes: 2,
            commit_grace_timeout_ms: 50,
        });
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();

        let pending = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("commit-preserved"),
                        Duration::from_secs(5),
                        progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });

        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let request = emitter.requests()[0].clone();

        assert!(matches!(
            broker.record_progress(ApplicationCommandProgress {
                request_id: request.request_id.clone(),
                status: ApplicationCommandStatus::Committing,
                stage: "commit".to_string(),
                message: Some("committing".to_string()),
                percent: Some(1.0),
            }),
            Ok(true)
        ));

        broker
            .unregister_dispatcher()
            .expect("unregister dispatcher");

        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: request.request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: true,
                    project_revision: 7,
                    data: json!({ "preserved": true }),
                    warnings: vec![],
                }),
            }),
            Ok(true)
        ));

        let result = pending
            .await
            .expect("join committing dispatch")
            .expect("dispatch result");
        assert_eq!(result.request_id, request.request_id);
        assert_eq!(result.project_revision, 7);
        assert_eq!(result.data, json!({ "preserved": true }));
        assert!(matches!(
            broker.cancellation_requested(&request.request_id),
            Ok(false)
        ));
    }

    #[tokio::test]
    async fn unregister_and_post_commit_outcomes_are_discoverable_without_false_rollback() {
        let (broker, emitter) = broker(2, 2);
        broker.register_dispatcher().expect("register dispatcher");

        let (unregister_progress_tx, _unregister_progress_rx) = mpsc::unbounded_channel();
        let unregistering = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("unregister"),
                        Duration::from_secs(5),
                        unregister_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        broker
            .unregister_dispatcher()
            .expect("unregister dispatcher");
        assert!(matches!(
            unregistering.await.expect("unregister task"),
            Err(crate::error::AppError::Cancelled(_))
        ));

        broker
            .register_dispatcher()
            .expect("register dispatcher again");
        let (commit_progress_tx, _commit_progress_rx) = mpsc::unbounded_channel();
        let commit_token = McpCancellationToken::new();
        let committing = tokio::spawn({
            let broker = broker.clone();
            let token = commit_token.clone();
            async move {
                broker
                    .dispatch(
                        test_command("commit"),
                        Duration::from_secs(5),
                        commit_progress_tx,
                        token,
                    )
                    .await
            }
        });
        while emitter.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
        let commit_request_id = emitter.requests()[1].request_id.clone();
        assert!(matches!(
            broker.record_progress(ApplicationCommandProgress {
                request_id: commit_request_id.clone(),
                status: ApplicationCommandStatus::Committing,
                stage: "commit".to_string(),
                message: None,
                percent: None,
            }),
            Ok(true)
        ));
        assert!(broker
            .forward_cancellation(&commit_request_id)
            .expect("forward post-commit cancellation"));
        assert!(emitter.cancellation_requests().contains(&commit_request_id));
        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: commit_request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: true,
                    project_revision: 9,
                    data: json!({ "committed": true }),
                    warnings: vec![],
                }),
            }),
            Ok(true)
        ));
        let committed = committing
            .await
            .expect("commit task")
            .expect("committed result");
        assert_eq!(committed.request_id, commit_request_id);
        assert_eq!(committed.data, json!({ "committed": true }));
        assert!(broker
            .committed_outcome(&commit_request_id)
            .expect("outcome lookup")
            .is_some());
    }

    #[tokio::test]
    async fn structured_application_command_errors_preserve_code_retryability_and_details() {
        let (broker, emitter) = broker(4, 4);
        broker.register_dispatcher().expect("register dispatcher");

        for (index, (code, retryable, details)) in [
            (
                "revision_conflict",
                true,
                json!({ "expected": 4, "actual": 5 }),
            ),
            ("user_denied", false, json!({ "policy": "confirmation" })),
            ("read_only", false, json!({ "mode": "readOnly" })),
            (
                "path_not_authorized",
                true,
                json!({ "rootId": "export-root" }),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
            let pending = tokio::spawn({
                let broker = broker.clone();
                async move {
                    broker
                        .dispatch(
                            test_command(&format!("error-{index}")),
                            Duration::from_secs(5),
                            progress_tx,
                            McpCancellationToken::new(),
                        )
                        .await
                }
            });
            while emitter.requests().len() <= index {
                tokio::task::yield_now().await;
            }
            let request_id = emitter.requests()[index].request_id.clone();
            broker
                .complete_application_command(McpBrokerCompletion {
                    request_id,
                    response: ApplicationCommandResponse::Error(McpCommandError {
                        code: code.to_string(),
                        message: format!("{code} message"),
                        retryable,
                        details: Some(details.clone()),
                    }),
                })
                .expect("complete error");
            let result = pending.await.expect("dispatch task");
            assert!(matches!(
                result,
                Err(crate::error::AppError::ApplicationCommand(error))
                    if error.code == code && error.retryable == retryable && error.details == Some(details)
            ));
        }
    }

    #[tokio::test]
    async fn committed_outcomes_are_bounded_and_skip_routine_success_retention() {
        let (broker, emitter) = broker(8, 8);
        broker.register_dispatcher().expect("register dispatcher");

        let (normal_progress_tx, _normal_progress_rx) = mpsc::unbounded_channel();
        let normal = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("normal-success"),
                        Duration::from_secs(5),
                        normal_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let normal_request_id = emitter.requests()[0].request_id.clone();
        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: normal_request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 1,
                    data: json!({ "normal": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete normal success");
        normal.await.expect("normal task").expect("normal response");
        assert_eq!(
            broker
                .committed_outcome(&normal_request_id)
                .expect("normal lookup"),
            None
        );

        let mut retained_ids = Vec::new();
        for index in 0..5 {
            let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
            let pending = tokio::spawn({
                let broker = broker.clone();
                async move {
                    broker
                        .dispatch(
                            test_command(&format!("late-{index}")),
                            Duration::from_secs(5),
                            progress_tx,
                            McpCancellationToken::new(),
                        )
                        .await
                }
            });
            while emitter.requests().len() < index + 2 {
                tokio::task::yield_now().await;
            }
            let request_id = emitter.requests()[index + 1].request_id.clone();
            broker
                .record_progress(ApplicationCommandProgress {
                    request_id: request_id.clone(),
                    status: ApplicationCommandStatus::Committing,
                    stage: "commit".to_string(),
                    message: None,
                    percent: None,
                })
                .expect("record committing");
            assert!(broker
                .mark_timeout_elapsed(&request_id)
                .expect("mark timeout"));
            broker
                .complete_application_command(McpBrokerCompletion {
                    request_id: request_id.clone(),
                    response: ApplicationCommandResponse::Success(McpCommandResult {
                        changed: true,
                        project_revision: index as u64 + 2,
                        data: json!({ "late": index }),
                        warnings: vec![],
                    }),
                })
                .expect("complete late success");
            pending.await.expect("late task").expect("late response");
            retained_ids.push(request_id);
        }

        assert_eq!(
            broker
                .committed_outcome(&retained_ids[0])
                .expect("evicted lookup"),
            None
        );
        for request_id in retained_ids.iter().skip(1) {
            assert!(broker
                .committed_outcome(request_id)
                .expect("retained lookup")
                .is_some());
        }
    }

    #[tokio::test]
    async fn post_commit_timeout_returns_uncertain_frees_capacity_and_late_success_updates_lookup()
    {
        let (broker, emitter) = broker_with_config(McpCommandBrokerConfig {
            max_pending: 1,
            max_concurrent: 1,
            max_committed_outcomes: 2,
            commit_grace_timeout_ms: 10,
        });
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();

        let committing = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("uncertain-success"),
                        Duration::from_millis(5),
                        progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let request_id = emitter.requests()[0].request_id.clone();
        broker
            .record_progress(ApplicationCommandProgress {
                request_id: request_id.clone(),
                status: ApplicationCommandStatus::Committing,
                stage: "commit".to_string(),
                message: None,
                percent: None,
            })
            .expect("record committing");

        let uncertain = tokio::time::timeout(Duration::from_millis(100), committing)
            .await
            .expect("commit grace must be finite")
            .expect("dispatch task");
        assert!(matches!(
            uncertain,
            Err(crate::error::AppError::ApplicationCommand(error))
                if error.code == "outcome_uncertain"
                    && error.message.contains("may have occurred")
                    && !error.message.contains("rollback")
                    && error.details == Some(json!({ "requestId": request_id.clone() }))
        ));
        assert!(matches!(
            broker.committed_outcome(&request_id).expect("uncertain lookup"),
            Some(ApplicationCommandResponse::Error(error)) if error.code == "outcome_uncertain"
        ));

        let (next_progress_tx, _next_progress_rx) = mpsc::unbounded_channel();
        let next = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        test_command("after-uncertain"),
                        Duration::from_secs(5),
                        next_progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().len() < 2 {
            tokio::task::yield_now().await;
        }
        let next_request_id = emitter.requests()[1].request_id.clone();
        broker
            .complete_application_command(McpBrokerCompletion {
                request_id: next_request_id,
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 7,
                    data: json!({ "next": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete next request");
        next.await.expect("next task").expect("next result");

        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: true,
                    project_revision: 8,
                    data: json!({ "late": "success" }),
                    warnings: vec![],
                }),
            }),
            Ok(true)
        ));
        assert!(matches!(
            broker.committed_outcome(&request_id).expect("late success lookup"),
            Some(ApplicationCommandResponse::Success(result))
                if result.data == json!({ "late": "success" })
        ));
    }

    #[tokio::test]
    async fn post_commit_late_error_is_recorded_truthfully_and_retention_is_bounded() {
        let (broker, emitter) = broker_with_config(McpCommandBrokerConfig {
            max_pending: 2,
            max_concurrent: 2,
            max_committed_outcomes: 2,
            commit_grace_timeout_ms: 5,
        });
        broker.register_dispatcher().expect("register dispatcher");
        let mut retained_ids = Vec::new();

        for index in 0..3 {
            let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
            let pending = tokio::spawn({
                let broker = broker.clone();
                async move {
                    broker
                        .dispatch(
                            test_command(&format!("late-error-{index}")),
                            Duration::from_millis(1),
                            progress_tx,
                            McpCancellationToken::new(),
                        )
                        .await
                }
            });
            while emitter.requests().len() <= index {
                tokio::task::yield_now().await;
            }
            let request_id = emitter.requests()[index].request_id.clone();
            broker
                .record_progress(ApplicationCommandProgress {
                    request_id: request_id.clone(),
                    status: ApplicationCommandStatus::Committing,
                    stage: "commit".to_string(),
                    message: None,
                    percent: None,
                })
                .expect("record committing");
            let result = pending.await.expect("pending task");
            assert!(matches!(
                result,
                Err(crate::error::AppError::ApplicationCommand(error))
                    if error.code == "outcome_uncertain" && !error.message.contains("rollback")
            ));
            broker
                .complete_application_command(McpBrokerCompletion {
                    request_id: request_id.clone(),
                    response: ApplicationCommandResponse::Error(McpCommandError {
                        code: "execution_failed".to_string(),
                        message:
                            "Frontend reported failure after commit began; commit may have occurred"
                                .to_string(),
                        retryable: true,
                        details: Some(json!({ "phase": "postCommit" })),
                    }),
                })
                .expect("record late error");
            retained_ids.push(request_id);
        }

        assert_eq!(
            broker.committed_outcome(&retained_ids[0]).expect("evicted"),
            None
        );
        for request_id in retained_ids.iter().skip(1) {
            assert!(matches!(
                broker.committed_outcome(request_id).expect("retained late error"),
                Some(ApplicationCommandResponse::Error(error))
                    if error.code == "execution_failed"
                        && error.message.contains("may have occurred")
                        && !error.message.contains("rollback")
            ));
        }
        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: retained_ids[0].clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: true,
                    project_revision: 99,
                    data: json!({ "evicted": true }),
                    warnings: vec![],
                }),
            }),
            Ok(false)
        ));
    }

    #[tokio::test]
    async fn post_commit_explicit_cancellation_uses_bounded_uncertain_outcome_path() {
        let (broker, emitter) = broker_with_config(McpCommandBrokerConfig {
            max_pending: 1,
            max_concurrent: 1,
            max_committed_outcomes: 1,
            commit_grace_timeout_ms: 5,
        });
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
        let token = McpCancellationToken::new();
        let pending = tokio::spawn({
            let broker = broker.clone();
            let token = token.clone();
            async move {
                broker
                    .dispatch(
                        test_command("cancel-after-commit"),
                        Duration::from_secs(5),
                        progress_tx,
                        token,
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let request_id = emitter.requests()[0].request_id.clone();
        broker
            .record_progress(ApplicationCommandProgress {
                request_id: request_id.clone(),
                status: ApplicationCommandStatus::Committing,
                stage: "commit".to_string(),
                message: None,
                percent: None,
            })
            .expect("record committing");
        token.cancel();

        let result = tokio::time::timeout(Duration::from_millis(100), pending)
            .await
            .expect("post-commit cancellation must be bounded")
            .expect("dispatch task");
        assert!(matches!(
            result,
            Err(crate::error::AppError::ApplicationCommand(error))
                if error.code == "outcome_uncertain"
                    && error.details == Some(json!({ "requestId": request_id.clone() }))
        ));
        assert_eq!(emitter.cancellation_requests(), vec![request_id.clone()]);

        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: request_id.clone(),
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: true,
                    project_revision: 11,
                    data: json!({ "cancelLateSuccess": true }),
                    warnings: vec![],
                }),
            }),
            Ok(true)
        ));
        assert!(matches!(
            broker.committed_outcome(&request_id).expect("retained success"),
            Some(ApplicationCommandResponse::Success(result))
                if result.data == json!({ "cancelLateSuccess": true })
        ));
    }

    #[tokio::test]
    async fn dispatch_rejects_absolute_path_keys_recursively_without_frontend_emit() {
        let cases = [
            json!({ "/": "root-only" }),
            json!({ "/srv/private/input.csv": "posix" }),
            json!({ "safe": { "C:\\": "drive-root" } }),
            json!({ "safe": { "C:/": "drive-root-slash" } }),
            json!({ "safe": { "C:\\Users\\ashton\\private.csv": "drive" } }),
            json!({ "safe": [{ "C:/Users/ashton/private.csv": "drive-slash" }] }),
            json!({ "safe": { "\\\\server\\share": "unc-root" } }),
            json!({ "safe": { "nested": { "\\\\server\\share\\private.csv": "unc" } } }),
        ];

        for (index, input) in cases.into_iter().enumerate() {
            let (broker, emitter) = broker(1, 1);
            broker.register_dispatcher().expect("register dispatcher");
            let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
            let result = broker
                .dispatch(
                    ApplicationCommandEnvelope {
                        command_type: "project.inspect".to_string(),
                        input,
                        control: None,
                    },
                    Duration::from_millis(20),
                    progress_tx,
                    McpCancellationToken::new(),
                )
                .await;
            assert!(
                matches!(
                    result,
                    Err(crate::error::AppError::InvalidParam(message))
                        if message == "Application command payload must not contain absolute paths"
                            && !message.contains("/srv")
                            && !message.contains("C:")
                            && !message.contains("server")
                ),
                "case {index} should reject absolute path keys without echoing the path"
            );
            assert_eq!(emitter.requests().len(), 0, "case {index} must not emit");
            assert_eq!(
                emitter.cancellation_requests().len(),
                0,
                "case {index} must not cancel work that never emitted"
            );
        }

        let (broker, emitter) = broker(1, 1);
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
        let result = broker
            .dispatch(
                ApplicationCommandEnvelope {
                    command_type: "project.inspect".to_string(),
                    input: json!({ "safe": true }),
                    control: Some(json!({ "safe": { "/private/control": "bad" } })),
                },
                Duration::from_millis(20),
                progress_tx,
                McpCancellationToken::new(),
            )
            .await;
        assert!(matches!(
            result,
            Err(crate::error::AppError::InvalidParam(message))
                if message == "Application command payload must not contain absolute paths"
                    && !message.contains("/private")
        ));
        assert_eq!(emitter.requests().len(), 0);
        assert_eq!(emitter.cancellation_requests().len(), 0);
    }

    #[tokio::test]
    async fn dispatch_allows_safe_relative_and_property_keys() {
        let (broker, emitter) = broker(1, 1);
        broker.register_dispatcher().expect("register dispatcher");
        let (progress_tx, _progress_rx) = mpsc::unbounded_channel();
        let pending = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .dispatch(
                        ApplicationCommandEnvelope {
                            command_type: "project.inspect".to_string(),
                            input: json!({
                                "relative/path.csv": "ok",
                                "C:relative": "ok",
                                "server\\share": "ok",
                                "property.name": { "nested-key": true }
                            }),
                            control: None,
                        },
                        Duration::from_secs(5),
                        progress_tx,
                        McpCancellationToken::new(),
                    )
                    .await
            }
        });
        while emitter.requests().is_empty() {
            tokio::task::yield_now().await;
        }
        let request_id = emitter.requests()[0].request_id.clone();
        broker
            .complete_application_command(McpBrokerCompletion {
                request_id,
                response: ApplicationCommandResponse::Success(McpCommandResult {
                    changed: false,
                    project_revision: 1,
                    data: json!({ "safe": true }),
                    warnings: vec![],
                }),
            })
            .expect("complete safe-key request");
        pending
            .await
            .expect("safe-key task")
            .expect("safe-key result");
    }
}
