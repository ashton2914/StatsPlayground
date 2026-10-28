//! Private commands for explicitly built and configured project performance probes.
use crate::{error::AppError,state::AppState};
use serde_json::Value;
#[cfg(all(feature="project-v5",feature="perf-harness"))]
fn runner()->Result<std::sync::Arc<crate::perf_project_v5_ui::UiProbeRunner>,AppError>{
    crate::perf_project_v5_ui::runtime()?.ok_or_else(||AppError::InvalidParam("project_ui_probe_unavailable".into()))
}
#[cfg(all(feature="project-v5",feature="perf-harness"))]
fn native_window_focused(app:&tauri::AppHandle)->Result<bool,AppError>{
    use tauri::Manager;
    app.get_webview_window("main").ok_or_else(||AppError::InvalidParam("project_ui_probe_window_missing".into()))?.is_focused().map_err(|error|AppError::InvalidParam(error.to_string()))
}
#[tauri::command]
pub fn project_ui_probe_configuration(app:tauri::AppHandle)->Result<Option<Value>,AppError>{
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    {
        use tauri::Manager;
        let mut config=crate::perf_project_v5_ui::runtime()?.map(|runner|runner.configuration());
        if let Some(config)=config.as_mut(){
            let window=app.get_webview_window("main").ok_or_else(||AppError::InvalidParam("project_ui_probe_window_missing".into()))?;
            window.set_always_on_top(true).map_err(|error|AppError::InvalidParam(error.to_string()))?;
            window.set_focus().map_err(|error|AppError::InvalidParam(error.to_string()))?;
            config["nativeWindowFocused"]=serde_json::json!(window.is_focused().map_err(|error|AppError::InvalidParam(error.to_string()))?);
        }
        Ok(config)
    }
    #[cfg(not(all(feature="project-v5",feature="perf-harness")))]
    {let _=app;Ok(None)}
}
#[tauri::command]
pub fn project_ui_probe_begin(app:tauri::AppHandle,state:tauri::State<'_,AppState>,scenario:String,expected_epoch:Option<u64>)->Result<u64,AppError>{
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    {let scenario=serde_json::from_value(Value::String(scenario)).map_err(|_|AppError::InvalidParam("project_ui_probe_scenario_invalid".into()))?;runner()?.begin(&state,scenario,expected_epoch,native_window_focused(&app)?)}
    #[cfg(not(all(feature="project-v5",feature="perf-harness")))]
    {let _=(app,state,scenario,expected_epoch);Err(AppError::InvalidParam("project_ui_probe_unavailable".into()))}
}
#[tauri::command]
pub fn project_ui_probe_finish(app:tauri::AppHandle,sample_id:u64,ui_ready_ms:Option<f64>,retention:Option<Value>,verification:bool,error:Option<String>)->Result<Value,AppError>{
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    {runner()?.finish(sample_id,ui_ready_ms,retention,verification,error,native_window_focused(&app)?)}
    #[cfg(not(all(feature="project-v5",feature="perf-harness")))]
    {let _=(app,sample_id,ui_ready_ms,retention,verification,error);Err(AppError::InvalidParam("project_ui_probe_unavailable".into()))}
}
#[tauri::command]
pub fn project_ui_probe_publish(scenario:String,run_error:Option<String>)->Result<String,AppError>{
    #[cfg(all(feature="project-v5",feature="perf-harness"))]
    {let scenario=serde_json::from_value(Value::String(scenario)).map_err(|_|AppError::InvalidParam("project_ui_probe_scenario_invalid".into()))?;Ok(runner()?.publish(scenario,run_error)?.to_string_lossy().into_owned())}
    #[cfg(not(all(feature="project-v5",feature="perf-harness")))]
    {let _=(scenario,run_error);Err(AppError::InvalidParam("project_ui_probe_unavailable".into()))}
}
