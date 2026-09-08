use std::sync::{Condvar, Mutex};

use crate::error::AppError;

#[derive(Debug, Default)]
struct CoordinatorState {
    saving: bool,
    save_waiting: bool,
    active_mutations: usize,
}

#[cfg(test)]
#[derive(Debug, Default)]
struct TestObserverState {
    save_waiting_registered: bool,
    begin_save_wait_entries: usize,
    save_started: bool,
}

#[cfg(test)]
#[derive(Debug, Default)]
struct TestObserver {
    state: Mutex<TestObserverState>,
    condvar: Condvar,
}

#[derive(Debug, Default)]
pub struct SaveCoordinator {
    state: Mutex<CoordinatorState>,
    condvar: Condvar,
    #[cfg(test)]
    observer: TestObserver,
}

impl SaveCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mutation_permit(&self) -> Result<MutationPermit<'_>, AppError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AppError::Database("Save coordinator lock poisoned".to_string()))?;

        if state.save_waiting || state.saving {
            return Err(AppError::ReadOnly(
                "Project is read-only while a save is pending or active".to_string(),
            ));
        }

        state.active_mutations = state.active_mutations.checked_add(1).ok_or_else(|| {
            AppError::Busy("Too many concurrent mutations to safely start a save".to_string())
        })?;

        Ok(MutationPermit {
            coordinator: self,
            released: false,
        })
    }

    pub fn begin_save(&self) -> Result<SaveGuard<'_>, AppError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AppError::Database("Save coordinator lock poisoned".to_string()))?;

        if state.save_waiting || state.saving {
            return Err(AppError::Busy(
                "Another save is already in progress".to_string(),
            ));
        }

        // Register save intent atomically before waiting so new mutation permits are blocked.
        state.save_waiting = true;
        #[cfg(test)]
        self.test_observe_save_waiting_registered();

        while state.active_mutations > 0 {
            #[cfg(test)]
            self.test_observe_begin_save_wait_entry();

            state = match self.condvar.wait(state) {
                Ok(guard) => guard,
                Err(poisoned) => {
                    let mut inner = poisoned.into_inner();
                    inner.save_waiting = false;
                    self.condvar.notify_all();
                    return Err(AppError::Database(
                        "Save coordinator lock poisoned while waiting for mutations".to_string(),
                    ));
                }
            };
        }

        state.save_waiting = false;
        state.saving = true;
        #[cfg(test)]
        self.test_observe_save_started();

        Ok(SaveGuard {
            coordinator: self,
            released: false,
        })
    }

    pub fn is_saving(&self) -> bool {
        match self.state.lock() {
            Ok(state) => state.saving || state.save_waiting,
            Err(_) => true,
        }
    }

    #[cfg(test)]
    fn test_wait_until_save_waiting_and_waiting_for_mutations(&self) {
        let mut observed = self.observer.state.lock().expect("observer lock");
        while !(observed.save_waiting_registered && observed.begin_save_wait_entries > 0) {
            observed = self.observer.condvar.wait(observed).expect("observer wait");
        }
    }

    #[cfg(test)]
    fn test_wait_until_begin_save_wait_entries_at_least(&self, expected: usize) {
        let mut observed = self.observer.state.lock().expect("observer lock");
        while observed.begin_save_wait_entries < expected {
            observed = self.observer.condvar.wait(observed).expect("observer wait");
        }
    }

    #[cfg(test)]
    fn test_wait_until_save_started(&self) {
        let mut observed = self.observer.state.lock().expect("observer lock");
        while !observed.save_started {
            observed = self.observer.condvar.wait(observed).expect("observer wait");
        }
    }

    #[cfg(test)]
    fn test_notify_spurious_wakeup_after_wait_parked(&self) {
        // Concurrency proof: acquiring the same mutex used by condvar.wait proves the
        // waiter has released it as part of parking in Condvar::wait. Notifying while
        // holding this lock prevents pre-wait lost notifications.
        let state = self.state.lock().expect("coordinator lock");
        assert!(state.save_waiting, "save intent must remain registered");
        assert!(
            state.active_mutations > 0,
            "active mutation must keep wait loop active"
        );
        self.condvar.notify_all();
        drop(state);
    }

    #[cfg(test)]
    fn test_set_active_mutations(&self, value: usize) {
        let mut state = self.state.lock().expect("coordinator lock");
        state.active_mutations = value;
    }

    #[cfg(test)]
    fn test_active_mutations(&self) -> usize {
        let state = self.state.lock().expect("coordinator lock");
        state.active_mutations
    }

    #[cfg(test)]
    fn test_observe_save_waiting_registered(&self) {
        let mut observed = self.observer.state.lock().expect("observer lock");
        observed.save_waiting_registered = true;
        self.observer.condvar.notify_all();
    }

    #[cfg(test)]
    fn test_observe_begin_save_wait_entry(&self) {
        let mut observed = self.observer.state.lock().expect("observer lock");
        observed.begin_save_wait_entries += 1;
        self.observer.condvar.notify_all();
    }

    #[cfg(test)]
    fn test_observe_save_started(&self) {
        let mut observed = self.observer.state.lock().expect("observer lock");
        observed.save_started = true;
        self.observer.condvar.notify_all();
    }
}

#[derive(Debug)]
pub struct MutationPermit<'a> {
    coordinator: &'a SaveCoordinator,
    released: bool,
}

impl Drop for MutationPermit<'_> {
    fn drop(&mut self) {
        if self.released {
            return;
        }

        if let Ok(mut state) = self.coordinator.state.lock() {
            state.active_mutations = state.active_mutations.checked_sub(1).unwrap_or(0);
        }

        self.released = true;
        self.coordinator.condvar.notify_all();
    }
}

#[derive(Debug)]
pub struct SaveGuard<'a> {
    coordinator: &'a SaveCoordinator,
    released: bool,
}

impl Drop for SaveGuard<'_> {
    fn drop(&mut self) {
        if self.released {
            return;
        }

        if let Ok(mut state) = self.coordinator.state.lock() {
            state.saving = false;
            state.save_waiting = false;
        }

        self.released = true;
        self.coordinator.condvar.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{mpsc, Arc};
    use std::thread;

    use crate::error::AppError;

    use super::{MutationPermit, SaveCoordinator, SaveGuard};

    fn run_spurious_wakeup_iteration() {
        let coordinator = Arc::new(SaveCoordinator::new());
        let permit = coordinator
            .mutation_permit()
            .expect("initial permit should be acquired");

        let thread_coordinator = Arc::clone(&coordinator);
        let (save_started_tx, save_started_rx) = mpsc::channel();
        let (release_save_tx, release_save_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            let guard = thread_coordinator.begin_save().expect("save should start");
            save_started_tx.send(()).expect("signal save started");
            release_save_rx.recv().expect("wait to release save");
            drop(guard);
        });

        coordinator.test_wait_until_save_waiting_and_waiting_for_mutations();
        coordinator.test_wait_until_begin_save_wait_entries_at_least(1);
        coordinator.test_notify_spurious_wakeup_after_wait_parked();
        coordinator.test_wait_until_begin_save_wait_entries_at_least(2);

        let while_still_waiting = coordinator
            .mutation_permit()
            .expect_err("permit should remain blocked after spurious wakeup");
        assert!(matches!(while_still_waiting, AppError::ReadOnly(_)));

        drop(permit);
        save_started_rx
            .recv()
            .expect("save should eventually start");

        release_save_tx.send(()).expect("release save");
        handle.join().expect("join save thread");
    }

    #[test]
    fn begin_save_waits_until_active_mutation_permit_drops_with_deterministic_handshake() {
        let coordinator = Arc::new(SaveCoordinator::new());
        let permit = coordinator
            .mutation_permit()
            .expect("permit should be acquired");

        let thread_coordinator = Arc::clone(&coordinator);
        let (save_started_tx, save_started_rx) = mpsc::channel();
        let (release_save_tx, release_save_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            let guard = thread_coordinator.begin_save().expect("save should start");
            save_started_tx.send(()).expect("signal save started");
            release_save_rx.recv().expect("wait for release");
            drop(guard);
        });

        coordinator.test_wait_until_save_waiting_and_waiting_for_mutations();

        let while_waiting = coordinator
            .mutation_permit()
            .expect_err("permit should be blocked once save intent is registered");
        assert!(matches!(while_waiting, AppError::ReadOnly(_)));

        drop(permit);

        coordinator.test_wait_until_save_started();
        save_started_rx.recv().expect("receive save-start signal");

        let while_saving = coordinator
            .mutation_permit()
            .expect_err("permit should be blocked while save is active");
        assert!(matches!(while_saving, AppError::ReadOnly(_)));

        release_save_tx.send(()).expect("release save");
        handle.join().expect("join save thread");
    }

    #[test]
    fn second_save_is_rejected_as_busy() {
        let coordinator = SaveCoordinator::new();
        let save_guard = coordinator.begin_save().expect("first save starts");

        let second = coordinator
            .begin_save()
            .expect_err("second save should fail");
        assert!(matches!(second, AppError::Busy(_)));

        drop(save_guard);
    }

    #[test]
    fn mutation_permit_is_rejected_while_save_intent_waits_or_save_active() {
        let coordinator = Arc::new(SaveCoordinator::new());
        let permit = coordinator
            .mutation_permit()
            .expect("initial permit should be acquired");

        let thread_coordinator = Arc::clone(&coordinator);
        let (save_started_tx, save_started_rx) = mpsc::channel();
        let (release_save_tx, release_save_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            let guard = thread_coordinator.begin_save().expect("save should start");
            save_started_tx.send(()).expect("signal save started");
            release_save_rx.recv().expect("wait to release save");
            drop(guard);
        });

        coordinator.test_wait_until_save_waiting_and_waiting_for_mutations();

        let while_waiting = coordinator
            .mutation_permit()
            .expect_err("permit should be blocked while save waits");
        assert!(matches!(while_waiting, AppError::ReadOnly(_)));

        drop(permit);
        save_started_rx
            .recv()
            .expect("save should start after drain");

        let while_saving = coordinator
            .mutation_permit()
            .expect_err("permit should be blocked while save active");
        assert!(matches!(while_saving, AppError::ReadOnly(_)));

        release_save_tx.send(()).expect("release save thread");
        handle.join().expect("join save thread");
    }

    #[test]
    fn begin_save_rechecks_condition_after_spurious_wakeup() {
        run_spurious_wakeup_iteration();
    }

    #[test]
    fn begin_save_rechecks_condition_after_spurious_wakeup_over_many_iterations() {
        for _ in 0..100 {
            run_spurious_wakeup_iteration();
        }
    }

    #[test]
    fn dropping_save_guard_restores_mutation_permit_acquisition() {
        let coordinator = SaveCoordinator::new();

        {
            let _save_guard = coordinator.begin_save().expect("save starts");
            let blocked = coordinator
                .mutation_permit()
                .expect_err("permit should be blocked during save");
            assert!(matches!(blocked, AppError::ReadOnly(_)));
        }

        let permit = coordinator
            .mutation_permit()
            .expect("permit should be restored after save guard drop");
        drop(permit);
    }

    #[test]
    fn dropping_save_guard_after_failed_operation_restores_mutation_permit() {
        let coordinator = SaveCoordinator::new();

        let save_result: Result<(), AppError> = {
            let _save_guard = coordinator.begin_save().expect("save starts");
            Err(AppError::FileIO("synthetic save failure".to_string()))
        };

        assert!(save_result.is_err());

        let permit = coordinator
            .mutation_permit()
            .expect("permit should be restored after failed save path");
        drop(permit);
    }

    #[test]
    fn mutation_permit_overflow_returns_error() {
        let coordinator = SaveCoordinator::new();
        coordinator.test_set_active_mutations(usize::MAX);

        let err = coordinator
            .mutation_permit()
            .expect_err("overflow must return an explicit error");
        assert!(matches!(err, AppError::Busy(_)));
    }

    #[test]
    fn mutation_permit_drop_does_not_underflow_active_count() {
        let coordinator = SaveCoordinator::new();
        coordinator.test_set_active_mutations(0);

        let permit = MutationPermit {
            coordinator: &coordinator,
            released: false,
        };
        drop(permit);

        assert_eq!(coordinator.test_active_mutations(), 0);
    }

    #[test]
    fn drop_paths_do_not_panic_when_state_mutex_is_poisoned() {
        let coordinator = Arc::new(SaveCoordinator::new());

        let poison_target = Arc::clone(&coordinator);
        let _ = thread::spawn(move || {
            let _guard = poison_target.state.lock().expect("lock state");
            panic!("poison save coordinator mutex");
        })
        .join();

        assert!(coordinator.is_saving(), "poison must fail-closed");

        let permit_drop = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let permit = MutationPermit {
                coordinator: &coordinator,
                released: false,
            };
            drop(permit);
        }));
        assert!(permit_drop.is_ok(), "mutation permit drop must not panic");

        let save_drop = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let guard = SaveGuard {
                coordinator: &coordinator,
                released: false,
            };
            drop(guard);
        }));
        assert!(save_drop.is_ok(), "save guard drop must not panic");
    }

    #[test]
    fn deliberate_mem_forget_of_save_guard_remains_fail_closed() {
        let coordinator = SaveCoordinator::new();

        let guard = coordinator.begin_save().expect("save starts");
        std::mem::forget(guard);

        let blocked = coordinator
            .mutation_permit()
            .expect_err("deliberately leaked guard must keep coordinator read-only");
        assert!(matches!(blocked, AppError::ReadOnly(_)));
    }
}
