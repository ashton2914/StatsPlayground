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
use crate::models::mcp::{McpAuditEntry, McpServerStatus};

const MAX_REQUEST_BODY_BYTES: usize = 1024 * 1024;

pub struct McpServerRuntime {
    inner: Mutex<McpServerInner>,
    audit_log: McpAuditLog,
}

#[derive(Default)]
struct McpServerInner {
    handle: Option<McpServerHandle>,
}

struct McpServerHandle {
    endpoint: String,
    token: BearerToken,
    broker: McpCommandBroker,
    limits: McpHttpLimitsState,
    shutdown: Option<oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl McpServerRuntime {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(McpServerInner::default()),
            audit_log: McpAuditLog::default(),
        }
    }

    pub async fn start(&self, broker: McpCommandBroker) -> Result<McpServerStatus, AppError> {
        if self
            .inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?
            .handle
            .is_some()
        {
            return self.status();
        }

        let token = BearerToken::generate();
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(AppError::from)?;
        let address = listener.local_addr().map_err(AppError::from)?;
        let endpoint = endpoint_for(address);
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
            .layer(from_fn_with_state(security_state, require_bearer));
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
            inner.handle = Some(McpServerHandle {
                endpoint,
                token,
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
        let handle = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|error| AppError::Database(error.to_string()))?;
            inner.handle.take()
        };
        if let Some(mut handle) = handle {
            handle
                .broker
                .cancel_non_committing_requests("MCP server stopped")?;
            if let Some(shutdown) = handle.shutdown.take() {
                let _ = shutdown.send(());
            }
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), handle.task).await;
        }
        self.audit_log.clear()?;
        Ok(())
    }

    pub fn status(&self) -> Result<McpServerStatus, AppError> {
        let inner = self
            .inner
            .lock()
            .map_err(|error| AppError::Database(error.to_string()))?;
        let Some(handle) = &inner.handle else {
            return Ok(McpServerStatus {
                state: "stopped".to_string(),
                endpoint: None,
                token: None,
                active_connections: 0,
                queued_requests: 0,
                running_requests: 0,
            });
        };
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

    pub fn audit_entries(&self) -> Result<Vec<McpAuditEntry>, AppError> {
        self.audit_log.list()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_uses_ipv4_loopback_and_mcp_path() {
        let address = SocketAddr::from(([127, 0, 0, 1], 48123));
        assert_eq!(endpoint_for(address), "http://127.0.0.1:48123/mcp");
    }
}
