use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, Notify, OwnedSemaphorePermit, Semaphore};
use uuid::Uuid;

use crate::error::AppError;
use crate::models::mcp::{
    ApplicationCommandEnvelope, ApplicationCommandProgress, ApplicationCommandRequestEvent,
    ApplicationCommandResponse, ApplicationCommandStatus, McpBrokerCompletion,
    McpCommandBrokerConfig, McpCommandError, McpCommandResponse,
};

const APPLICATION_COMMAND_REQUEST_EVENT: &str = "application-command-request";

pub trait ApplicationCommandEventEmitter: Clone + Send + Sync + 'static {
    fn emit_application_command_request(
        &self,
        event: ApplicationCommandRequestEvent,
    ) -> Result<(), AppError>;
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
    committed_outcomes: Mutex<HashMap<String, McpCommandResponse>>,
    semaphore: Arc<Semaphore>,
    config: McpCommandBrokerConfig,
}

struct PendingEntry {
    completion: Option<oneshot::Sender<ApplicationCommandResponse>>,
    progress_sender: mpsc::UnboundedSender<ApplicationCommandProgress>,
    cancellation_token: McpCancellationToken,
    committing: bool,
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
                committed_outcomes: Mutex::new(HashMap::new()),
                semaphore: Arc::new(Semaphore::new(max_concurrent)),
                config: McpCommandBrokerConfig {
                    max_pending: config.max_pending.max(1),
                    max_concurrent,
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
        for entry in pending.values_mut() {
            entry.cancellation_token.cancel();
            if let Some(sender) = entry.completion.take() {
                let _ = sender.send(ApplicationCommandResponse::Error(McpCommandError {
                    code: "cancelled".to_string(),
                    message: "Application command dispatcher unregistered".to_string(),
                    retryable: true,
                    details: None,
                }));
            }
        }
        pending.clear();
        Ok(())
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

        let request_id = format!("mcp-{}", Uuid::new_v4());
        let (completion_tx, completion_rx) = oneshot::channel();
        self.insert_pending(
            request_id.clone(),
            PendingEntry {
                completion: Some(completion_tx),
                progress_sender,
                cancellation_token: cancellation_token.clone(),
                committing: false,
            },
        )?;

        let permit = match self.acquire_slot(&cancellation_token).await {
            Ok(permit) => permit,
            Err(error) => {
                self.remove_pending(&request_id)?;
                return Err(error);
            }
        };

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
            timeout,
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
            return Ok(false);
        };
        let request_id = completion.request_id.clone();
        if let ApplicationCommandResponse::Success(result) = &completion.response {
            let response = McpCommandResponse::from_result(request_id.clone(), result.clone());
            self.inner
                .committed_outcomes
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?
                .insert(request_id, response);
        }
        if let Some(sender) = entry.completion.take() {
            sender.send(completion.response).map_err(|_| {
                AppError::FileIO("Application command response channel closed".to_string())
            })?;
        }
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
    ) -> Result<Option<McpCommandResponse>, AppError> {
        self.inner
            .committed_outcomes
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))
            .map(|outcomes| outcomes.get(request_id).cloned())
    }

    async fn acquire_slot(
        &self,
        cancellation_token: &McpCancellationToken,
    ) -> Result<OwnedSemaphorePermit, AppError> {
        tokio::select! {
            permit = self.inner.semaphore.clone().acquire_owned() => {
                permit.map_err(|error| AppError::Busy(error.to_string()))
            }
            _ = cancellation_token.cancelled() => {
                Err(AppError::Cancelled("Application command cancelled".to_string()))
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
        timeout: Duration,
        permit: OwnedSemaphorePermit,
    ) -> Result<McpCommandResponse, AppError> {
        let result = tokio::select! {
            response = completion_rx => self.response_to_result(request_id.clone(), response),
            _ = cancellation_token.cancelled() => self.handle_cancellation(request_id.clone()).await,
            _ = tokio::time::sleep(timeout) => self.handle_timeout(request_id.clone()).await,
        };
        drop(permit);
        result
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
            ApplicationCommandResponse::Error(error) => Err(AppError::InvalidParam(error.message)),
        }
    }

    async fn handle_cancellation(
        &self,
        request_id: String,
    ) -> Result<McpCommandResponse, AppError> {
        if let Some(outcome) = self.committed_outcome(&request_id)? {
            return Ok(outcome);
        }
        if self.is_committing(&request_id)? {
            return self.wait_for_committed_outcome(request_id).await;
        }
        self.remove_pending(&request_id)?;
        Err(AppError::Cancelled(
            "Application command cancelled".to_string(),
        ))
    }

    async fn handle_timeout(&self, request_id: String) -> Result<McpCommandResponse, AppError> {
        if let Some(outcome) = self.committed_outcome(&request_id)? {
            return Ok(outcome);
        }
        if self.is_committing(&request_id)? {
            return self.wait_for_committed_outcome(request_id).await;
        }
        self.remove_pending(&request_id)?;
        Err(AppError::Busy("Application command timeout".to_string()))
    }

    fn is_committing(&self, request_id: &str) -> Result<bool, AppError> {
        self.inner
            .pending
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))
            .map(|pending| {
                pending
                    .get(request_id)
                    .map(|entry| entry.committing)
                    .unwrap_or(false)
            })
    }

    async fn wait_for_committed_outcome(
        &self,
        request_id: String,
    ) -> Result<McpCommandResponse, AppError> {
        loop {
            if let Some(outcome) = self.committed_outcome(&request_id)? {
                return Ok(outcome);
            }
            tokio::task::yield_now().await;
        }
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
            for value in values.values() {
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
    use std::sync::{Arc, Mutex};
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
    }

    impl RecordingEmitter {
        fn requests(&self) -> Vec<ApplicationCommandRequestEvent> {
            self.events.lock().expect("test emitter lock").clone()
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
            },
        );
        (broker, emitter)
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
        cancel_token.cancel();
        let cancelled = queued.await.expect("queued task");
        assert!(
            matches!(cancelled, Err(crate::error::AppError::Cancelled(message)) if message.contains("cancelled"))
        );
    }

    #[tokio::test]
    async fn running_cancellation_unregister_and_post_commit_outcomes_are_discoverable() {
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
        assert!(matches!(
            broker.cancellation_requested(&running_request_id),
            Ok(true)
        ));
        assert!(matches!(
            broker.complete_application_command(McpBrokerCompletion {
                request_id: running_request_id,
                response: ApplicationCommandResponse::Error(McpCommandError {
                    code: "cancelled".to_string(),
                    message: "Command cancelled".to_string(),
                    retryable: false,
                    details: None,
                }),
            }),
            Ok(true)
        ));
        assert!(matches!(
            running.await.expect("running task"),
            Err(crate::error::AppError::Cancelled(_))
        ));

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
        while emitter.requests().len() < 2 {
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
        while emitter.requests().len() < 3 {
            tokio::task::yield_now().await;
        }
        let commit_request_id = emitter.requests()[2].request_id.clone();
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
        commit_token.cancel();
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
        assert_eq!(
            broker
                .committed_outcome(&commit_request_id)
                .expect("outcome lookup")
                .is_some(),
            true
        );
    }
}
