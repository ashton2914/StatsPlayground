//! Operation-owned cancellation for explicit project conversion.
use std::sync::{Arc,Mutex,MutexGuard};
use crate::error::AppError;

#[derive(Default)]
pub(crate) struct MigrationRequests {active:Mutex<Option<(String,Arc<Mutex<RequestPhase>>)>>}
pub(crate) struct MigrationRequest<'a> {owner:&'a MigrationRequests,id:String,cancellation:Arc<Mutex<RequestPhase>>}
fn request_id(id:&str)->Result<String,AppError> {
    uuid::Uuid::parse_str(id).map(|id|id.to_string()).map_err(|_|AppError::InvalidParam("project_migration_request_invalid".into()))
}
impl MigrationRequests {
    pub(crate) fn register(&self,id:&str)->Result<MigrationRequest<'_>,AppError> {
        let id=request_id(id)?;
        let mut active=self.active.lock().map_err(|_|AppError::Busy("project_migration_unavailable".into()))?;
        if active.is_some(){return Err(AppError::Busy("project_migration_in_progress".into()));}
        let cancellation=Arc::new(Mutex::new(RequestPhase::Active));
        *active=Some((id.clone(),Arc::clone(&cancellation)));
        Ok(MigrationRequest{owner:self,id,cancellation})
    }
    pub(crate) fn cancel(&self,id:&str)->Result<bool,AppError> {
        let id=request_id(id)?;
        let token=self.active.lock().map_err(|_|AppError::Busy("project_migration_unavailable".into()))?.as_ref().filter(|(key,_)|key==&id).map(|(_,token)|Arc::clone(token));
        if let Some(token)=token {let mut phase=token.lock().map_err(|_|AppError::Busy("project_migration_unavailable".into()))?;match *phase{RequestPhase::Active|RequestPhase::Cancelled=>{*phase=RequestPhase::Cancelled;Ok(true)},RequestPhase::Publishing|RequestPhase::Finished=>Ok(false)}}else{Ok(false)}
    }
}
#[derive(Clone,Copy)]
enum RequestPhase {Active,Cancelled,Publishing,Finished}
/// The guard spans the actual COMMIT or no-clobber file link. Cancellation
/// cannot acknowledge success while publication owns this mutex.
pub(crate) struct MigrationPublication<'a> {phase:MutexGuard<'a,RequestPhase>}
impl Drop for MigrationPublication<'_>{fn drop(&mut self){*self.phase=RequestPhase::Finished;}}
impl MigrationRequest<'_> {
    pub(crate) fn cancelled(&self)->bool {self.cancellation.lock().map(|phase|matches!(*phase,RequestPhase::Cancelled)).unwrap_or(true)}
    pub(crate) fn begin_publication(&self)->Result<MigrationPublication<'_>,AppError>{
        let mut phase=self.cancellation.lock().map_err(|_|AppError::Busy("project_migration_unavailable".into()))?;
        match *phase{RequestPhase::Cancelled=>return Err(AppError::Cancelled("project_group_transfer_cancelled".into())),RequestPhase::Active=>*phase=RequestPhase::Publishing,_=>return Err(AppError::Busy("project_group_already_published".into()))}
        Ok(MigrationPublication{phase})
    }
}
impl Drop for MigrationRequest<'_> {
    fn drop(&mut self) {
        if let Ok(mut active)=self.owner.active.lock() {
            if active.as_ref().is_some_and(|(id,token)|id==&self.id&&Arc::ptr_eq(token,&self.cancellation)){*active=None;}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_linked_groups_review_publication_fences_cancel_before_commit_and_link(){
        use crate::services::{project_group_copy::tests::fixture,project_group_operations::tests::context};
        let (dir,db,ids)=fixture();let registry=MigrationRequests::default();
        let id=uuid::Uuid::new_v4().to_string();let token=registry.register(&id).unwrap();let revision=db.committed_revision().unwrap();let request=crate::models::project_topology::ProjectGroupMoveRequest{target_table_id:ids[0].clone(),destination_folder:String::new(),expected_topology_revision:revision};
        assert!(db.copy_table_group_guarded(&context(&db,"cancel-at-commit"),&request,||false,||{assert!(registry.cancel(&id).unwrap());token.begin_publication()}).is_err());assert_eq!(db.committed_revision().unwrap(),revision);assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),5);drop(token);
        let id=uuid::Uuid::new_v4().to_string();let token=registry.register(&id).unwrap();let file=dir.path().join("cancel-at-link.spprj");let export=crate::models::project_topology::ProjectGroupExportRequest{target_table_id:ids[0].clone(),file_path:file.to_str().unwrap().into(),expected_topology_revision:revision};
        assert!(db.export_table_group_guarded(db.epoch(),&export,||false,||{assert!(registry.cancel(&id).unwrap());token.begin_publication()}).is_err());assert!(!file.exists());drop(token);
        let valid=dir.path().join("valid-group.spprj");db.export_table_group(db.epoch(),&crate::models::project_topology::ProjectGroupExportRequest{file_path:valid.to_str().unwrap().into(),..export},||false).unwrap();
        let destination=crate::services::project_database::ProjectDatabase::create(&dir.path().join("destination.spprj"),false).unwrap();let id=uuid::Uuid::new_v4().to_string();let token=registry.register(&id).unwrap();
        assert!(destination.import_table_group_guarded(&context(&destination,"cancel-import-at-commit"),&crate::models::project_topology::ProjectGroupImportRequest{file_path:valid.to_str().unwrap().into(),destination_folder:String::new()},||false,||{assert!(registry.cancel(&id).unwrap());token.begin_publication()}).is_err());assert!(destination.with_engine(|e|e.list_datasets()).unwrap().is_empty());
    }
    #[test]
    fn project_linked_groups_review_publication_wins_late_cancel_at_actual_commit(){
        use crate::services::{project_group_copy::tests::fixture,project_group_operations::tests::context};
        let (_dir,db,ids)=fixture();let registry=MigrationRequests::default();let id=uuid::Uuid::new_v4().to_string();let token=registry.register(&id).unwrap();let req=crate::models::project_topology::ProjectGroupMoveRequest{target_table_id:ids[0].clone(),destination_folder:String::new(),expected_topology_revision:db.committed_revision().unwrap()};let ctx=context(&db,"commit-wins");
        let (entered_tx,entered_rx)=std::sync::mpsc::channel();let (release_tx,release_rx)=std::sync::mpsc::channel();
        std::thread::scope(|scope|{let database=&db;let request=&req;let context=&ctx;let owner=&token;let published=scope.spawn(move||database.copy_table_group_guarded(context,request,||false,||{let guard=owner.begin_publication()?;entered_tx.send(()).unwrap();release_rx.recv().unwrap();Ok(guard)}));entered_rx.recv().unwrap();let cancelled=scope.spawn(||registry.cancel(&id).unwrap());release_tx.send(()).unwrap();published.join().unwrap().unwrap();assert!(!cancelled.join().unwrap(),"cancel must not claim success after the publication lock is acquired");});assert_eq!(db.with_engine(|e|e.list_datasets()).unwrap().len(),9);
    }
    #[test]
    fn project_v5_migration_request_cancellation_is_owned_and_releases_on_drop() {
        let id=uuid::Uuid::new_v4().to_string();
        let other=uuid::Uuid::new_v4().to_string();
        let registry=MigrationRequests::default();
        let request=registry.register(&id).unwrap();
        assert!(!request.cancelled());
        assert!(registry.register(&id).is_err());
        assert!(registry.register(&other).is_err(),"only one full conversion may stage at a time");
        assert!(!registry.cancel(&other).unwrap());assert!(!request.cancelled());
        assert!(registry.cancel(&id).unwrap());assert!(request.cancelled());
        drop(request);
        assert!(!registry.cancel(&id).unwrap());
        let next=registry.register(&id).unwrap();assert!(!next.cancelled());drop(next);
        assert!(registry.register("not-a-request-id").is_err());
        assert!(registry.cancel("not-a-request-id").is_err());
    }
}
