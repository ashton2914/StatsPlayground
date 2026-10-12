#[cfg(test)]
use crate::services::vscode_workspace::merge_config;
use crate::{
    error::AppError,
    mcp::{
        broker::McpCommandBroker,
        server::{McpServerRuntime, McpStartConfiguration},
    },
    models::mcp::{McpServerStatus, McpSettings},
    services::{
        mcp_settings_service::McpSettingsService,
        vscode_workspace::{failure, Workspace},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeLaunchPlan {
    pub configuration_path: String,
    pub plan_id: String,
    pub workspace_display_name: String,
    pub configuration_action: String,
    pub confirmation_required: bool,
    pub current_endpoint: Option<String>,
    pub proposed_endpoint: String,
    pub git_protection: String,
    pub settings_action: String,
    pub warnings: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VsCodeLaunchRequest {
    pub plan_id: String,
    pub approve_conflict: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VsCodeLaunchResult {
    pub configuration_path: String,
    pub workspace_display_name: String,
    pub configuration_result: String,
    pub server_state: String,
    pub endpoint: String,
    pub launch_result: String,
    pub warnings: Vec<String>,
}
struct PlanRecord {
    created: Instant,
    workspace: Workspace,
    saved: Option<McpSettings>,
    runtime: Fingerprint,
    preview: VsCodeLaunchPlan,
}
#[derive(PartialEq)]
struct Fingerprint {
    state: String,
    endpoint: Option<String>,
    token: Option<String>,
}
impl From<McpServerStatus> for Fingerprint {
    fn from(s: McpServerStatus) -> Self {
        Self {
            state: s.state,
            endpoint: s.endpoint,
            token: s.token,
        }
    }
}
#[derive(Default)]
pub struct VsCodeLaunchService {
    plans: Mutex<HashMap<String, PlanRecord>>,
    execution_gate: tokio::sync::Mutex<()>,
}
fn load(home: &Path) -> Result<Option<McpSettings>, AppError> {
    McpSettingsService::new(home.to_owned())
        .load()
        .map_err(|_| {
            failure(
                "Cannot read persistent MCP settings. Repair the settings file before launching.",
            )
        })
}
fn active_settings(status: &Fingerprint) -> Result<McpSettings, AppError> {
    let port = status
        .endpoint
        .as_deref()
        .and_then(|s| s.strip_prefix("http://127.0.0.1:"))
        .and_then(|s| s.strip_suffix("/mcp"))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| failure("MCP endpoint is unavailable."))?;
    let settings = McpSettings {
        port,
        token: status
            .token
            .clone()
            .ok_or_else(|| failure("MCP credential is unavailable."))?,
    };
    McpSettingsService::validate(&settings)
        .map_err(|_| failure("Active MCP settings are invalid."))?;
    Ok(settings)
}
fn readiness(saved: &Option<McpSettings>, status: &Fingerprint) -> Result<&'static str, AppError> {
    match (saved,status.state.as_str()) {
        (Some(settings),"running") if active_settings(status)? == *settings => Ok("reuse"),
        (Some(_),"running") => Err(failure("Running MCP endpoint or token differs from saved settings. Stop the server before retrying.")),
        (Some(_),"stopped") => Ok("startSaved"),
        (None,"running") => {active_settings(status)?;Ok("persistRunning")},
        (None,"stopped") => Ok("initializePersistent"),
        _ => Err(failure("MCP server is transitioning. Wait before launching VS Code.")),
    }
}
async fn ensure_persistent(
    home: &Path,
    runtime: &McpServerRuntime,
    broker: McpCommandBroker,
    saved: Option<McpSettings>,
) -> Result<McpSettings, AppError> {
    let before = Fingerprint::from(runtime.status()?);
    readiness(&saved, &before)?;
    let started = std::sync::atomic::AtomicBool::new(false);
    if before.state == "stopped" {
        runtime
            .start_with_configuration_loader(broker, || {
                if load(home)? != saved {
                    return Err(failure("MCP settings changed. Create a new launch plan."));
                }
                started.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(saved
                    .clone()
                    .map(McpStartConfiguration::from_settings)
                    .unwrap_or_else(McpStartConfiguration::transient))
            })
            .await
            .map_err(|_| {
                failure("Cannot start MCP server. Check whether the saved port is already in use.")
            })?;
    }
    let active = active_settings(&Fingerprint::from(runtime.status()?))?;
    if let Some(settings) = saved {
        if active != settings {
            return Err(failure(
                "Running MCP settings differ from persistent settings.",
            ));
        }
    } else {
        let result = runtime.with_active_configuration(&active, || {
            if load(home)?.is_some() {
                return Err(failure("MCP settings changed. Create a new launch plan."));
            }
            McpSettingsService::new(home.to_owned())
                .save(&active)
                .map_err(|_| failure("Cannot persist MCP settings. Check home folder permissions."))
        });
        if let Err(error) = result {
            if started.load(std::sync::atomic::Ordering::SeqCst) {
                runtime.stop().await?;
            }
            return Err(error);
        }
    }
    Ok(active)
}
impl VsCodeLaunchService {
    pub fn plan(
        &self,
        path: &Path,
        home: &Path,
        runtime: &McpServerRuntime,
    ) -> Result<VsCodeLaunchPlan, AppError> {
        let workspace = Workspace::inspect(path)?;
        let saved = load(home)?;
        let fingerprint = Fingerprint::from(runtime.status()?);
        let settings_action = readiness(&saved, &fingerprint)?;
        let preview_settings = match &saved {
            Some(s) => s.clone(),
            None if fingerprint.state == "running" => active_settings(&fingerprint)?,
            None => McpSettings {
                port: 1,
                token: "preview".repeat(6),
            },
        };
        let edit = workspace.merge_config(&preview_settings)?;
        let mut warnings = vec!["localCredential".into()];
        if settings_action == "initializePersistent" {
            warnings.push("initializePersistent".into());
        }
        let preview = VsCodeLaunchPlan {
            configuration_path: workspace.configuration_path().into(),
            plan_id: uuid::Uuid::new_v4().to_string(),
            workspace_display_name: workspace
                .canonical
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Folder".into()),
            configuration_action: edit.action.into(),
            confirmation_required: edit.confirmation_required,
            current_endpoint: edit.current_endpoint,
            proposed_endpoint: if settings_action == "initializePersistent" {
                "Available loopback port".into()
            } else {
                format!("http://127.0.0.1:{}/mcp", preview_settings.port)
            },
            git_protection: workspace.git_status().into(),
            settings_action: settings_action.into(),
            warnings,
        };
        let mut plans = self
            .plans
            .lock()
            .map_err(|_| failure("Launch planner unavailable."))?;
        plans.retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
        if plans.len() >= 32 {
            return Err(failure(
                "Too many pending launch plans. Retry in five minutes.",
            ));
        }
        plans.insert(
            preview.plan_id.clone(),
            PlanRecord {
                created: Instant::now(),
                workspace,
                saved,
                runtime: fingerprint,
                preview: preview.clone(),
            },
        );
        Ok(preview)
    }
    pub async fn execute(
        &self,
        request: VsCodeLaunchRequest,
        home: &Path,
        runtime: &McpServerRuntime,
        broker: McpCommandBroker,
    ) -> Result<VsCodeLaunchResult, AppError> {
        self.execute_with(request, home, runtime, broker, launch_stable)
            .await
    }
    async fn execute_with(
        &self,
        request: VsCodeLaunchRequest,
        home: &Path,
        runtime: &McpServerRuntime,
        broker: McpCommandBroker,
        launch: impl FnOnce(&Path) -> String,
    ) -> Result<VsCodeLaunchResult, AppError> {
        let _gate = self.execution_gate.lock().await;
        let plan = self
            .plans
            .lock()
            .map_err(|_| failure("Launch planner unavailable."))?
            .remove(&request.plan_id)
            .ok_or_else(|| {
                failure("Launch plan expired or was already used. Select the folder again.")
            })?;
        if plan.created.elapsed() >= Duration::from_secs(300)
            || plan.saved != load(home)?
            || plan.runtime != Fingerprint::from(runtime.status()?)
        {
            return Err(failure("Launch plan is stale. Select the folder again."));
        }
        plan.workspace.validate()?;
        if plan.preview.confirmation_required && !request.approve_conflict {
            return Err(failure(
                "Explicit approval is required to replace the existing StatsPlayground entry.",
            ));
        }
        plan.workspace.protect_git()?;
        let active = ensure_persistent(home, runtime, broker, plan.saved).await?;
        let edit = plan.workspace.merge_config(&active)?;
        runtime.with_active_configuration(&active, || {
            if load(home)?.as_ref() != Some(&active) {
                return Err(failure(
                    "Persistent MCP settings changed. Create a new plan.",
                ));
            }
            plan.workspace.validate()?;
            if edit.action != "unchanged" {
                plan.workspace.write(edit.bytes.as_bytes())?;
            }
            Ok(())
        })?;
        let launch_result = launch(&plan.workspace.canonical);
        Ok(VsCodeLaunchResult {
            configuration_path: plan.preview.configuration_path,
            workspace_display_name: plan.preview.workspace_display_name,
            configuration_result: edit.action.into(),
            server_state: "running".into(),
            endpoint: format!("http://127.0.0.1:{}/mcp", active.port),
            launch_result,
            warnings: vec!["localCredential".into()],
        })
    }
}
fn launch_command(platform: &str, editor: &Path, workspace: &Path) -> (PathBuf, Vec<OsString>) {
    if platform == "macos" {
        (
            PathBuf::from("/usr/bin/open"),
            vec![
                "-a".into(),
                editor.as_os_str().into(),
                "--args".into(),
                workspace.as_os_str().into(),
            ],
        )
    } else {
        (editor.to_owned(), vec![workspace.as_os_str().into()])
    }
}
fn discover_stable() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut candidates = vec![PathBuf::from("/Applications/Visual Studio Code.app")];
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join("Applications/Visual Studio Code.app"));
        }
        candidates
            .into_iter()
            .find(|p| p.join("Contents/MacOS/Electron").is_file())
    }
    #[cfg(target_os = "windows")]
    {
        for (variable, suffix) in [
            ("LOCALAPPDATA", "Programs/Microsoft VS Code/Code.exe"),
            ("ProgramFiles", "Microsoft VS Code/Code.exe"),
            ("ProgramFiles(x86)", "Microsoft VS Code/Code.exe"),
        ] {
            if let Some(root) = std::env::var_os(variable) {
                let path = PathBuf::from(root).join(suffix);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let search = std::env::var_os("PATH")?;
        for directory in std::env::split_paths(&search)
            .filter(|p| p.is_absolute())
            .take(64)
        {
            #[cfg(target_os = "windows")]
            let name = "code.exe";
            #[cfg(not(target_os = "windows"))]
            let name = "code";
            let path = directory.join(name);
            if !path.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if std::fs::metadata(&path).ok()?.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            let canonical = std::fs::canonicalize(&path).ok()?;
            if canonical
                .to_string_lossy()
                .to_lowercase()
                .contains("insiders")
            {
                continue;
            }
            return Some(path);
        }
        None
    }
}
fn launch_stable(workspace: &Path) -> String {
    let Some(editor) = discover_stable() else {
        return "configuredVsCodeNotFound".into();
    };
    let (executable, args) = launch_command(std::env::consts::OS, &editor, workspace);
    // Wait for the short-lived launcher so an immediate non-zero exit is a
    // partial result, while allowing the editor process itself to stay open.
    #[cfg(target_os = "macos")]
    let result = Command::new(executable)
        .args(args)
        .status()
        .map(|s| s.success());
    #[cfg(not(target_os = "macos"))]
    let result = Command::new(executable)
        .args(args)
        .spawn()
        .map(|mut child| {
            std::thread::sleep(Duration::from_millis(100));
            match child.try_wait() {
                Ok(Some(status)) => status.success(),
                Ok(None) => {
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    true
                }
                Err(_) => false,
            }
        });
    if result.unwrap_or(false) {
        "launched".into()
    } else {
        "configuredLaunchFailed".into()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::{
        broker::McpCommandBroker,
        server::{McpServerRuntime, McpStartConfiguration},
    };
    use tempfile::TempDir;

    #[tokio::test]
    async fn initialize_persists_bound_port_and_restarts_at_same_endpoint() {
        let home = TempDir::new().unwrap();
        let workspace = TempDir::new().unwrap();
        let service = VsCodeLaunchService::default();
        let runtime = McpServerRuntime::new();
        let broker = McpCommandBroker::new();
        let plan = service
            .plan(workspace.path(), home.path(), &runtime)
            .unwrap();
        assert_eq!(plan.settings_action, "initializePersistent");
        assert_eq!(plan.configuration_path, ".mcp.json");
        let result = service
            .execute_with(
                VsCodeLaunchRequest {
                    plan_id: plan.plan_id.clone(),
                    approve_conflict: false,
                },
                home.path(),
                &runtime,
                broker.clone(),
                |_| "configuredVsCodeNotFound".into(),
            )
            .await
            .unwrap();
        assert_eq!(result.launch_result, "configuredVsCodeNotFound");
        assert_eq!(result.configuration_path, ".mcp.json");
        let saved = McpSettingsService::new(home.path().to_owned())
            .load()
            .unwrap()
            .unwrap();
        let status = runtime.status().unwrap();
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(workspace.path().join(".mcp.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            config["mcpServers"]["StatsPlayground"]["headers"]["Authorization"],
            format!("Bearer {}", saved.token)
        );
        assert!(config.get("servers").is_none());
        assert!(!workspace.path().join(".vscode/mcp.json").exists());
        assert_eq!(
            status.endpoint.as_deref(),
            Some(format!("http://127.0.0.1:{}/mcp", saved.port).as_str())
        );
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains(&saved.token));
        assert!(!serialized.contains(workspace.path().to_str().unwrap()));
        assert!(service
            .execute_with(
                VsCodeLaunchRequest {
                    plan_id: plan.plan_id,
                    approve_conflict: false
                },
                home.path(),
                &runtime,
                broker.clone(),
                |_| "launched".into()
            )
            .await
            .is_err());
        runtime.stop().await.unwrap();
        let restarted = runtime
            .start(broker, McpStartConfiguration::from_settings(saved))
            .await
            .unwrap();
        assert_eq!(restarted.endpoint, status.endpoint);
        runtime.stop().await.unwrap();
    }

    #[tokio::test]
    async fn source_changes_and_missing_conflict_approval_do_not_write() {
        let home = TempDir::new().unwrap();
        let folder = TempDir::new().unwrap();
        std::fs::create_dir(folder.path().join(".vscode")).unwrap();
        let path = folder.path().join(".vscode/mcp.json");
        let source = r#"{"servers":{"StatsPlayground":{"command":"old"}}}"#;
        std::fs::write(&path, source).unwrap();
        let runtime = McpServerRuntime::new();
        let service = VsCodeLaunchService::default();
        let plan = service.plan(folder.path(), home.path(), &runtime).unwrap();
        assert!(plan.confirmation_required);
        assert!(service
            .execute_with(
                VsCodeLaunchRequest {
                    plan_id: plan.plan_id,
                    approve_conflict: false
                },
                home.path(),
                &runtime,
                McpCommandBroker::new(),
                |_| "launched".into()
            )
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
        assert_eq!(runtime.status().unwrap().state, "stopped");
        let plan = service.plan(folder.path(), home.path(), &runtime).unwrap();
        std::fs::write(&path, "{}").unwrap();
        assert!(service
            .execute_with(
                VsCodeLaunchRequest {
                    plan_id: plan.plan_id,
                    approve_conflict: true
                },
                home.path(),
                &runtime,
                McpCommandBroker::new(),
                |_| "launched".into()
            )
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
    }

    #[tokio::test]
    async fn persistence_failure_stops_new_server() {
        let home = TempDir::new().unwrap();
        let runtime = McpServerRuntime::new();
        std::fs::write(home.path().join(".statsplayground"), "blocked").unwrap();
        assert!(
            ensure_persistent(home.path(), &runtime, McpCommandBroker::new(), None)
                .await
                .is_err()
        );
        assert_eq!(runtime.status().unwrap().state, "stopped");
    }

    #[tokio::test]
    async fn transient_runtime_is_persisted_and_saved_mismatch_rejected() {
        let home = TempDir::new().unwrap();
        let runtime = McpServerRuntime::new();
        let status = runtime
            .start(McpCommandBroker::new(), McpStartConfiguration::transient())
            .await
            .unwrap();
        let saved = ensure_persistent(home.path(), &runtime, McpCommandBroker::new(), None)
            .await
            .unwrap();
        assert_eq!(Some(saved.token.clone()), status.token);
        let different = McpSettings {
            port: saved.port,
            token: "b".repeat(32),
        };
        McpSettingsService::new(home.path().to_owned())
            .save(&different)
            .unwrap();
        assert!(ensure_persistent(
            home.path(),
            &runtime,
            McpCommandBroker::new(),
            Some(different)
        )
        .await
        .is_err());
        runtime.stop().await.unwrap();
    }

    #[test]
    fn platform_arguments_keep_workspace_as_one_argument() {
        let path = Path::new("/space and ; quote' folder");
        for platform in ["windows", "linux", "macos"] {
            let command = launch_command(platform, Path::new("/editor"), path);
            assert_eq!(command.1.last().unwrap(), path.as_os_str());
            assert_eq!(command.1.len(), if platform == "macos" { 4 } else { 1 });
        }
    }
}

#[cfg(test)]
mod stale_tests {
    use super::*;
    #[tokio::test]
    async fn expired_plan_and_runtime_change_are_rejected() {
        let home = tempfile::TempDir::new().unwrap();
        let folder = tempfile::TempDir::new().unwrap();
        let service = VsCodeLaunchService::default();
        let runtime = McpServerRuntime::new();
        let plan = service.plan(folder.path(), home.path(), &runtime).unwrap();
        service
            .plans
            .lock()
            .unwrap()
            .get_mut(&plan.plan_id)
            .unwrap()
            .created = Instant::now() - Duration::from_secs(301);
        assert!(service
            .execute_with(
                VsCodeLaunchRequest {
                    plan_id: plan.plan_id,
                    approve_conflict: false
                },
                home.path(),
                &runtime,
                McpCommandBroker::new(),
                |_| "launched".into()
            )
            .await
            .is_err());
        let plan = service.plan(folder.path(), home.path(), &runtime).unwrap();
        runtime
            .start(McpCommandBroker::new(), McpStartConfiguration::transient())
            .await
            .unwrap();
        assert!(service
            .execute_with(
                VsCodeLaunchRequest {
                    plan_id: plan.plan_id,
                    approve_conflict: false
                },
                home.path(),
                &runtime,
                McpCommandBroker::new(),
                |_| "launched".into()
            )
            .await
            .is_err());
        assert!(!folder.path().join(".vscode/mcp.json").exists());
        runtime.stop().await.unwrap();
    }
}

#[cfg(test)]
mod unchanged_race_tests {
    use super::*;
    #[tokio::test]
    async fn unchanged_source_modified_during_saved_server_start_is_rejected() {
        let home = tempfile::TempDir::new().unwrap();
        let folder = tempfile::TempDir::new().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let settings = McpSettings {
            port: listener.local_addr().unwrap().port(),
            token: "a".repeat(32),
        };
        drop(listener);
        McpSettingsService::new(home.path().to_owned())
            .save(&settings)
            .unwrap();
        std::fs::create_dir(folder.path().join(".vscode")).unwrap();
        let path = folder.path().join(".vscode/mcp.json");
        std::fs::write(&path, merge_config(None, &settings).unwrap().bytes).unwrap();
        let service = VsCodeLaunchService::default();
        let runtime = McpServerRuntime::new();
        let plan = service.plan(folder.path(), home.path(), &runtime).unwrap();
        assert_eq!(plan.configuration_action, "unchanged");
        let execution = service.execute_with(
            VsCodeLaunchRequest {
                plan_id: plan.plan_id,
                approve_conflict: false,
            },
            home.path(),
            &runtime,
            McpCommandBroker::new(),
            |_| panic!("must not launch with stale configuration"),
        );
        let change = async {
            while runtime.status().unwrap().state != "running" {
                tokio::task::yield_now().await;
            }
            std::fs::write(&path, "{}").unwrap();
        };
        let (result, ()) = tokio::join!(execution, change);
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        runtime.stop().await.unwrap();
    }
}
