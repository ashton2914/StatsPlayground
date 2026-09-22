use std::net::SocketAddr;
use std::sync::Mutex;

use axum::middleware::from_fn_with_state;
use axum::Router;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::error::AppError;
use crate::mcp::broker::McpCommandBroker;
use crate::mcp::security::{
    enforce_http_limits, require_bearer, BearerToken, McpHttpLimitsState, McpHttpSecurityState,
};
use crate::mcp::tools::{McpAuditLog, StatsPlaygroundMcpServer};
pub use crate::models::mcp::McpSettings;
use crate::models::mcp::{McpAuditEntry, McpServerStatus};

const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;
#[cfg(debug_assertions)]
const MCP_BIND_ENV: &str = "STATSPLAYGROUND_MCP_BIND";
#[cfg(debug_assertions)]
const MCP_TOKEN_ENV: &str = "STATSPLAYGROUND_MCP_TOKEN";

pub struct McpStartConfiguration {
    bind_address: String,
    token: BearerToken,
}

impl McpStartConfiguration {
    pub fn transient() -> Self {
        Self {
            bind_address: "127.0.0.1:0".to_string(),
            token: BearerToken::generate(),
        }
    }

    pub fn from_settings(settings: McpSettings) -> Self {
        Self {
            bind_address: format!("127.0.0.1:{}", settings.port),
            token: BearerToken::from_runtime_value(settings.token),
        }
    }
}

pub struct McpServerRuntime {
    inner: Mutex<McpServerState>,
    operation_gate: Mutex<()>,
    audit_log: McpAuditLog,
}

enum McpServerState {
    Stopped,
    Starting,
    Running(McpServerHandle),
    Stopping,
}

struct McpServerHandle {
    endpoint: String,
    token: BearerToken,
    security: McpHttpSecurityState,
    broker: McpCommandBroker,
    limits: McpHttpLimitsState,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl McpServerRuntime {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(McpServerState::Stopped),
            operation_gate: Mutex::new(()),
            audit_log: McpAuditLog::default(),
        }
    }

    pub async fn start(
        &self,
        broker: McpCommandBroker,
        configuration: McpStartConfiguration,
    ) -> Result<McpServerStatus, AppError> {
        self.start_with_configuration_loader(broker, || Ok(configuration))
            .await
    }

    pub(crate) async fn start_with_configuration_loader<F>(
        &self,
        broker: McpCommandBroker,
        load_configuration: F,
    ) -> Result<McpServerStatus, AppError>
    where
        F: FnOnce() -> Result<McpStartConfiguration, AppError>,
    {
        let configuration = {
            let _operation = self
                .operation_gate
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            let mut state = self
                .inner
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            match &*state {
                McpServerState::Stopped => {
                    let configuration = load_configuration()?;
                    *state = McpServerState::Starting;
                    configuration
                }
                McpServerState::Running(handle) => return running_status(handle),
                McpServerState::Starting => {
                    return Err(AppError::Busy("MCP server is starting".to_string()));
                }
                McpServerState::Stopping => {
                    return Err(AppError::Busy("MCP server is stopping".to_string()));
                }
            }
        };

        let configuration = mcp_start_configuration(configuration);
        let bind_address: SocketAddr = match configuration.bind_address.parse() {
            Ok(address) => address,
            Err(error) => {
                self.finish_failed_start()?;
                return Err(AppError::InvalidParam(format!(
                    "Invalid MCP bind address: {error}"
                )));
            }
        };
        if bind_address.ip() != std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST) {
            self.finish_failed_start()?;
            return Err(AppError::InvalidParam(
                "MCP server bind address must use 127.0.0.1".to_string(),
            ));
        }
        let listener = match TcpListener::bind(bind_address).await {
            Ok(listener) => listener,
            Err(error) => {
                self.finish_failed_start()?;
                return Err(AppError::from(error));
            }
        };
        let address = match listener.local_addr() {
            Ok(address) => address,
            Err(error) => {
                self.finish_failed_start()?;
                return Err(AppError::from(error));
            }
        };
        let endpoint = endpoint_for(address);
        let token = configuration.token;
        let security_state = McpHttpSecurityState::new(token.clone());
        let limits_state = McpHttpLimitsState::default();
        let audit_log = self.audit_log.clone();
        let server = StatsPlaygroundMcpServer::new(broker.clone(), audit_log.clone());
        let config = StreamableHttpServerConfig::default()
            .with_allowed_hosts([
                format!("127.0.0.1:{}", address.port()),
                format!("localhost:{}", address.port()),
            ])
            .with_allowed_origins([
                "tauri://localhost".to_string(),
                "http://localhost".to_string(),
                format!("http://localhost:{}", address.port()),
                format!("http://127.0.0.1:{}", address.port()),
            ])
            .with_max_request_body_bytes(MAX_REQUEST_BODY_BYTES)
            .with_legacy_session_mode(true)
            .with_json_response(true);
        let service: StreamableHttpService<StatsPlaygroundMcpServer, LocalSessionManager> =
            StreamableHttpService::new(move || Ok(server.clone()), Default::default(), config);
        let router = Router::new()
            .nest_service("/mcp", service)
            .layer(from_fn_with_state(
                limits_state.clone(),
                enforce_http_limits,
            ))
            .layer(from_fn_with_state(security_state.clone(), require_bearer));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;
        });

        {
            let mut inner = self
                .inner
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            *inner = McpServerState::Running(McpServerHandle {
                endpoint,
                token,
                security: security_state,
                broker,
                limits: limits_state,
                shutdown: Some(shutdown_tx),
                task,
            });
        }
        tokio::task::yield_now().await;
        self.status()
    }

    pub async fn stop(&self) -> Result<(), AppError> {
        let mut handle = {
            let mut state = self
                .inner
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            match std::mem::replace(&mut *state, McpServerState::Stopping) {
                McpServerState::Running(handle) => handle,
                McpServerState::Stopped => {
                    *state = McpServerState::Stopped;
                    self.audit_log.clear()?;
                    return Ok(());
                }
                McpServerState::Starting => {
                    *state = McpServerState::Starting;
                    return Err(AppError::Busy("MCP server is starting".to_string()));
                }
                McpServerState::Stopping => return Ok(()),
            }
        };
        handle.security.revoke();
        let cancel_result = handle
            .broker
            .cancel_non_committing_requests("MCP server stopped");
        if let Some(shutdown) = handle.shutdown.take() {
            let _ = shutdown.send(());
        }
        if tokio::time::timeout(std::time::Duration::from_secs(2), &mut handle.task)
            .await
            .is_err()
        {
            handle.task.abort();
            let _ = handle.task.await;
        }
        let audit_result = self.audit_log.clear();
        *self
            .inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))? = McpServerState::Stopped;
        cancel_result.and(audit_result)
    }

    pub fn status(&self) -> Result<McpServerStatus, AppError> {
        let state = self
            .inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        match &*state {
            McpServerState::Stopped => Ok(inactive_status("stopped")),
            McpServerState::Starting => Ok(inactive_status("starting")),
            McpServerState::Running(handle) => running_status(handle),
            McpServerState::Stopping => Ok(inactive_status("stopping")),
        }
    }

    pub fn ensure_stopped(&self) -> Result<(), AppError> {
        let state = self
            .inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        match &*state {
            McpServerState::Stopped => Ok(()),
            McpServerState::Starting => Err(AppError::Busy(
                "MCP server is starting; stop it before changing settings".to_string(),
            )),
            McpServerState::Running(_) => Err(AppError::Busy(
                "MCP server is running; stop it before changing settings".to_string(),
            )),
            McpServerState::Stopping => Err(AppError::Busy(
                "MCP server is stopping; wait before changing settings".to_string(),
            )),
        }
    }

    pub(crate) fn run_while_stopped<T, F>(&self, operation: F) -> Result<T, AppError>
    where
        F: FnOnce() -> Result<T, AppError>,
    {
        let _operation = self
            .operation_gate
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        self.ensure_stopped()?;
        operation()
    }

    pub fn audit_entries(&self) -> Result<Vec<McpAuditEntry>, AppError> {
        self.audit_log.list()
    }

    fn finish_failed_start(&self) -> Result<(), AppError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        if matches!(*state, McpServerState::Starting) {
            *state = McpServerState::Stopped;
        }
        Ok(())
    }
}

impl Default for McpServerRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn endpoint_for(address: SocketAddr) -> String {
    format!("http://127.0.0.1:{}/mcp", address.port())
}

#[cfg(debug_assertions)]
fn mcp_start_configuration(mut configuration: McpStartConfiguration) -> McpStartConfiguration {
    if let Ok(bind_address) = std::env::var(MCP_BIND_ENV) {
        configuration.bind_address = bind_address;
    }
    if let Ok(token) = std::env::var(MCP_TOKEN_ENV) {
        configuration.token = BearerToken::from_runtime_value(token);
    }
    configuration
}

#[cfg(not(debug_assertions))]
fn mcp_start_configuration(configuration: McpStartConfiguration) -> McpStartConfiguration {
    configuration
}

fn inactive_status(state: &str) -> McpServerStatus {
    McpServerStatus {
        state: state.to_string(),
        endpoint: None,
        token: None,
        active_connections: 0,
        queued_requests: 0,
        running_requests: 0,
    }
}

fn running_status(handle: &McpServerHandle) -> Result<McpServerStatus, AppError> {
    let (queued_requests, running_requests) = handle.broker.queue_status()?;
    Ok(McpServerStatus {
        state: "running".to_string(),
        endpoint: Some(handle.endpoint.clone()),
        token: Some(handle.token.expose_for_management()),
        active_connections: handle.limits.active_requests(),
        queued_requests,
        running_requests,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use super::*;
    use crate::mcp::broker::McpCommandBroker;

    #[test]
    fn endpoint_uses_ipv4_loopback_and_mcp_path() {
        let address = SocketAddr::from(([127, 0, 0, 1], 48123));
        assert_eq!(endpoint_for(address), "http://127.0.0.1:48123/mcp");
    }

    #[test]
    fn production_configuration_uses_random_loopback_defaults() {
        let first = McpStartConfiguration::transient();
        let second = McpStartConfiguration::transient();

        assert_eq!(first.bind_address, "127.0.0.1:0");
        assert_eq!(second.bind_address, "127.0.0.1:0");
        assert_ne!(
            first.token.expose_for_management(),
            second.token.expose_for_management()
        );
    }

    #[tokio::test]
    async fn ensure_stopped_accepts_only_the_stopped_state() {
        let runtime = McpServerRuntime::new();
        runtime.ensure_stopped().expect("stopped runtime");

        *runtime.inner.lock().expect("runtime state") = McpServerState::Starting;
        assert!(matches!(runtime.ensure_stopped(), Err(AppError::Busy(_))));

        *runtime.inner.lock().expect("runtime state") = McpServerState::Stopping;
        assert!(matches!(runtime.ensure_stopped(), Err(AppError::Busy(_))));

        *runtime.inner.lock().expect("runtime state") = McpServerState::Stopped;
        runtime
            .start(McpCommandBroker::new(), McpStartConfiguration::transient())
            .await
            .expect("start runtime");
        assert!(matches!(runtime.ensure_stopped(), Err(AppError::Busy(_))));
        runtime.stop().await.expect("stop runtime");
    }

    #[tokio::test]
    async fn start_rejects_ipv6_loopback_bind_address() {
        let runtime = McpServerRuntime::new();
        let result = runtime
            .start(
                McpCommandBroker::new(),
                McpStartConfiguration {
                    bind_address: "[::1]:0".to_string(),
                    token: BearerToken::generate(),
                },
            )
            .await;

        assert!(matches!(result, Err(AppError::InvalidParam(_))));
        assert_eq!(runtime.status().expect("runtime status").state, "stopped");
    }

    #[tokio::test]
    async fn start_rejects_noncanonical_ipv4_loopback_bind_address() {
        let runtime = McpServerRuntime::new();
        let result = runtime
            .start(
                McpCommandBroker::new(),
                McpStartConfiguration {
                    bind_address: "127.0.0.2:0".to_string(),
                    token: BearerToken::generate(),
                },
            )
            .await;
        let rejected = matches!(result, Err(AppError::InvalidParam(_)));
        if !rejected {
            runtime.stop().await.expect("stop runtime");
        }

        assert!(rejected);
        assert_eq!(runtime.status().expect("runtime status").state, "stopped");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn start_configuration_load_waits_for_stopped_operation() {
        let runtime = Arc::new(McpServerRuntime::new());
        let (save_entered_tx, save_entered_rx) = mpsc::channel();
        let (release_save_tx, release_save_rx) = mpsc::channel();
        let save_runtime = runtime.clone();
        let save_task = tokio::task::spawn_blocking(move || {
            save_runtime.run_while_stopped(|| {
                save_entered_tx.send(()).expect("signal save entered");
                release_save_rx.recv().expect("release save");
                Ok(())
            })
        });
        save_entered_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("save operation entered");

        let (load_called_tx, mut load_called_rx) = tokio::sync::oneshot::channel();
        let (start_attempted_tx, start_attempted_rx) = tokio::sync::oneshot::channel();
        let start_runtime = runtime.clone();
        let start_task = tokio::spawn(async move {
            let _ = start_attempted_tx.send(());
            start_runtime
                .start_with_configuration_loader(McpCommandBroker::new(), || {
                    let _ = load_called_tx.send(());
                    Ok(McpStartConfiguration::transient())
                })
                .await
        });
        start_attempted_rx.await.expect("start attempted");
        let loaded_while_save_active =
            tokio::time::timeout(Duration::from_millis(100), &mut load_called_rx)
                .await
                .is_ok();

        release_save_tx.send(()).expect("release save operation");
        save_task
            .await
            .expect("join save operation")
            .expect("save operation");
        let status = start_task
            .await
            .expect("join start operation")
            .expect("start runtime");
        runtime.stop().await.expect("stop runtime");

        assert!(!loaded_while_save_active);
        assert_eq!(status.state, "running");
    }
}
