//! Operation-owned cancellation for explicit project conversion.
use std::sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}};
use crate::error::AppError;

#[derive(Default)]
pub(crate) struct MigrationRequests {active:Mutex<Option<(String,Arc<AtomicBool>)>>}
pub(crate) struct MigrationRequest<'a> {owner:&'a MigrationRequests,id:String,cancellation:Arc<AtomicBool>}
fn request_id(id:&str)->Result<String,AppError> {
    uuid::Uuid::parse_str(id).map(|id|id.to_string()).map_err(|_|AppError::InvalidParam("project_migration_request_invalid".into()))
}
impl MigrationRequests {
    pub(crate) fn register(&self,id:&str)->Result<MigrationRequest<'_>,AppError> {
        let id=request_id(id)?;
        let mut active=self.active.lock().map_err(|_|AppError::Busy("project_migration_unavailable".into()))?;
        if active.is_some(){return Err(AppError::Busy("project_migration_in_progress".into()));}
        let cancellation=Arc::new(AtomicBool::new(false));
        *active=Some((id.clone(),Arc::clone(&cancellation)));
        Ok(MigrationRequest{owner:self,id,cancellation})
    }
    pub(crate) fn cancel(&self,id:&str)->Result<bool,AppError> {
        let id=request_id(id)?;
        let token=self.active.lock().map_err(|_|AppError::Busy("project_migration_unavailable".into()))?.as_ref().filter(|(key,_)|key==&id).map(|(_,token)|Arc::clone(token));
        if let Some(token)=token {token.store(true,Ordering::Release);Ok(true)}else{Ok(false)}
    }
}
impl MigrationRequest<'_> {pub(crate) fn cancelled(&self)->bool {self.cancellation.load(Ordering::Acquire)}}
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
