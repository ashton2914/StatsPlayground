//! Explicit table exports hold their selected project for the export lifetime.

use std::sync::MutexGuard;
use crate::{error::AppError,state::AppState};

pub(crate) fn acquire_export_project(state:&AppState,epoch:Option<u64>)->Result<MutexGuard<'_,()>,AppError> {
 let lease=state.project_transition.lock().map_err(|_|AppError::Busy("project_transition_unavailable".into()))?;
 let active=state.project_database.read().map_err(|error|AppError::Database(error.to_string()))?;
 match (active.as_ref(),epoch) {
  (Some(database),Some(expected)) if database.epoch()==expected=>{},
  (None,None)=>{},
  (Some(_),None)=>return Err(AppError::InvalidParam("project_epoch_required".into())),
  _=>return Err(AppError::InvalidParam("project_epoch_stale".into())),
 }
 drop(active);Ok(lease)
}

#[cfg(all(test,feature="project-v5"))]
mod tests {
 use crate::{state::AppState,services::{project_database::ProjectDatabase,project_native_service::NativeProjectService}};
 #[test]
 fn project_export_lease_binds_epoch_and_blocks_lifecycle_replacement() {
  let state=AppState::new().unwrap();drop(super::acquire_export_project(&state,None).unwrap());
  let dir=tempfile::tempdir().unwrap();let path=dir.path().join("native.spprj");let db=ProjectDatabase::create(&path,false).unwrap();db.shutdown().unwrap();
  let native=NativeProjectService::new(&state);let opened=native.open(&path,false).unwrap();
  assert!(super::acquire_export_project(&state,None).is_err());assert!(super::acquire_export_project(&state,Some(opened.epoch+1)).is_err());
  let lease=super::acquire_export_project(&state,Some(opened.epoch)).unwrap();assert!(state.project_transition.try_lock().is_err());drop(lease);
  native.close(opened.epoch).unwrap();assert!(super::acquire_export_project(&state,Some(opened.epoch)).is_err());
 }
}
