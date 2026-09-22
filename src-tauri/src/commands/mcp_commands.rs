use std::path::Path;

use tauri::{AppHandle, Manager, State};

use crate::error::AppError;
use crate::mcp::security::BearerToken;
use crate::mcp::server::{McpServerRuntime, McpStartConfiguration};
use crate::models::mcp::{
    McpAuditEntry, McpBrokerCompletion, McpBrokerUpdate, McpServerStatus, McpSettings,
    McpSettingsState,
};
use crate::services::mcp_settings_service::McpSettingsService;
use crate::state::AppState;

fn settings_service(app: &AppHandle) -> Result<McpSettingsService, AppError> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| AppError::FileIO(error.to_string()))?;
    Ok(McpSettingsService::new(home))
}

fn load_start_configuration(home: &Path) -> Result<McpStartConfiguration, AppError> {
    Ok(match McpSettingsService::new(home.to_path_buf()).load()? {
        Some(settings) => McpStartConfiguration::from_settings(settings),
        None => McpStartConfiguration::transient(),
    })
}

fn load_settings(home: &Path) -> Result<McpSettingsState, AppError> {
    Ok(McpSettingsState {
        settings: McpSettingsService::new(home.to_path_buf()).load()?,
    })
}

fn save_settings(
    home: &Path,
    runtime: &McpServerRuntime,
    settings: McpSettings,
) -> Result<McpSettingsState, AppError> {
    runtime.ensure_stopped()?;
    McpSettingsService::new(home.to_path_buf()).save(&settings)?;
    Ok(McpSettingsState {
        settings: Some(settings),
    })
}

#[tauri::command(async)]
pub async fn start_mcp_server(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<McpServerStatus, AppError> {
    let configuration = load_start_configuration(
        &app.path()
            .home_dir()
            .map_err(|error| AppError::FileIO(error.to_string()))?,
    )?;
    state
        .mcp_server
        .start(state.mcp_command_broker.clone(), configuration)
        .await
}

#[tauri::command(async)]
pub async fn stop_mcp_server(state: State<'_, AppState>) -> Result<(), AppError> {
    state.mcp_server.stop().await
}

#[tauri::command]
pub fn get_mcp_server_status(state: State<'_, AppState>) -> Result<McpServerStatus, AppError> {
    state.mcp_server.status()
}

#[tauri::command]
pub fn get_mcp_settings(app: AppHandle) -> Result<McpSettingsState, AppError> {
    let service = settings_service(&app)?;
    Ok(McpSettingsState {
        settings: service.load()?,
    })
}

#[tauri::command]
pub fn save_mcp_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: McpSettings,
) -> Result<McpSettingsState, AppError> {
    state.mcp_server.ensure_stopped()?;
    let service = settings_service(&app)?;
    service.save(&settings)?;
    Ok(McpSettingsState {
        settings: Some(settings),
    })
}

#[tauri::command]
pub fn generate_mcp_token() -> Result<String, AppError> {
    Ok(BearerToken::generate_for_management())
}

#[tauri::command]
pub fn list_mcp_audit_entries(state: State<'_, AppState>) -> Result<Vec<McpAuditEntry>, AppError> {
    state.mcp_server.audit_entries()
}

#[tauri::command]
pub fn register_application_command_dispatcher(state: State<'_, AppState>) -> Result<(), AppError> {
    state.mcp_command_broker.register_dispatcher()
}

#[tauri::command]
pub fn complete_application_command(
    state: State<'_, AppState>,
    update: McpBrokerUpdate,
) -> Result<bool, AppError> {
    match update.into_progress_or_completion() {
        Ok(progress) => state.mcp_command_broker.record_progress(progress),
        Err(McpBrokerCompletion {
            request_id,
            response,
        }) => state
            .mcp_command_broker
            .complete_application_command(McpBrokerCompletion {
                request_id,
                response,
            }),
    }
}

#[tauri::command]
pub fn unregister_application_command_dispatcher(
    state: State<'_, AppState>,
) -> Result<(), AppError> {
    state.mcp_command_broker.unregister_dispatcher()
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;
    use crate::mcp::broker::McpCommandBroker;
    use crate::models::mcp::McpSettings;
    use crate::services::mcp_settings_service::McpSettingsService;

    fn reserve_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0")
            .expect("reserve port")
            .local_addr()
            .expect("reserved address")
            .port()
    }

    #[tokio::test]
    async fn missing_home_settings_produce_transient_start_configuration() {
        let home = TempDir::new().expect("home");
        let runtime = McpServerRuntime::new();
        let status = runtime
            .start(
                McpCommandBroker::new(),
                load_start_configuration(home.path()).expect("configuration"),
            )
            .await
            .expect("start");

        assert!(status
            .endpoint
            .expect("endpoint")
            .starts_with("http://127.0.0.1:"));
        assert!(status.token.expect("token").len() >= 32);
        runtime.stop().await.expect("stop");
    }

    #[tokio::test]
    async fn home_settings_produce_fixed_start_configuration() {
        let home = TempDir::new().expect("home");
        let settings = McpSettings {
            port: reserve_port(),
            token: "f".repeat(32),
        };
        McpSettingsService::new(home.path().to_path_buf())
            .save(&settings)
            .expect("save fixture");
        let runtime = McpServerRuntime::new();
        let status = runtime
            .start(
                McpCommandBroker::new(),
                load_start_configuration(home.path()).expect("configuration"),
            )
            .await
            .expect("start");

        assert_eq!(
            status.endpoint,
            Some(format!("http://127.0.0.1:{}/mcp", settings.port))
        );
        assert_eq!(status.token, Some(settings.token));
        runtime.stop().await.expect("stop");
    }

    #[test]
    fn load_and_save_settings_use_the_supplied_home_directory() {
        let home = TempDir::new().expect("home");
        assert_eq!(
            load_settings(home.path())
                .expect("missing settings")
                .settings,
            None
        );
        let runtime = McpServerRuntime::new();
        let settings = McpSettings {
            port: reserve_port(),
            token: "s".repeat(32),
        };

        assert_eq!(
            save_settings(home.path(), &runtime, settings.clone())
                .expect("save settings")
                .settings,
            Some(settings.clone())
        );
        assert_eq!(
            McpSettingsService::new(home.path().to_path_buf())
                .load()
                .expect("load persisted settings"),
            Some(settings)
        );
    }

    #[tokio::test]
    async fn save_settings_checks_runtime_is_stopped_before_writing() {
        let home = TempDir::new().expect("home");
        let runtime = McpServerRuntime::new();
        runtime
            .start(McpCommandBroker::new(), McpStartConfiguration::transient())
            .await
            .expect("start");

        let result = save_settings(
            home.path(),
            &runtime,
            McpSettings {
                port: reserve_port(),
                token: "b".repeat(32),
            },
        );

        assert!(matches!(result, Err(AppError::Busy(_))));
        assert_eq!(
            McpSettingsService::new(home.path().to_path_buf())
                .load()
                .expect("load settings"),
            None
        );
        runtime.stop().await.expect("stop");
    }

    #[test]
    fn generated_management_tokens_pass_settings_validation() {
        let settings = McpSettings {
            port: reserve_port(),
            token: generate_mcp_token().expect("generate token"),
        };

        McpSettingsService::validate(&settings).expect("valid generated token");
    }
}
