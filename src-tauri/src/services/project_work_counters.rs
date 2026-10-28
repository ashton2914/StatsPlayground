//! Actual bulk-work boundaries, isolated per unit-test thread and per probe process.
#[cfg(test)]
thread_local! { static COUNTERS: std::cell::Cell<[u64;3]> = const { std::cell::Cell::new([0;3]) }; }
#[cfg(not(test))]
static COUNTERS: [std::sync::atomic::AtomicU64;3] = [const {std::sync::atomic::AtomicU64::new(0)};3];
fn add(index:usize,count:u64) {
    #[cfg(test)] COUNTERS.with(|cell|{let mut values=cell.get();values[index]=values[index].saturating_add(count);cell.set(values);});
    #[cfg(not(test))] COUNTERS[index].fetch_add(count,std::sync::atomic::Ordering::Relaxed);
}
pub(crate) fn restored_rows(count:usize){add(0,count as u64);}
pub(crate) fn archive_write(){add(1,1);}
pub(crate) fn database_copy(){add(2,1);}
pub(crate) fn reset(){
    #[cfg(test)] COUNTERS.with(|cell|cell.set([0;3]));
    #[cfg(not(test))] for counter in &COUNTERS {counter.store(0,std::sync::atomic::Ordering::Relaxed);}
    super::table_mutation_coordinator::reset_full_before_table_copy_counter();
    crate::engine::duckdb_engine::reset_full_anchor_rebuild_counter();
    crate::engine::duckdb_engine::reset_window_full_count_counter();
}
pub(crate) fn snapshot()->serde_json::Value {
    #[cfg(test)] let values=COUNTERS.with(std::cell::Cell::get);
    #[cfg(not(test))] let values=std::array::from_fn::<_,3,_>(|index|COUNTERS[index].load(std::sync::atomic::Ordering::Relaxed));
    serde_json::json!({"archiveRestoredRows":values[0],"archiveWriterCalls":values[1],"fullDatabaseCopies":values[2],"fullBeforeImageCopies":super::table_mutation_coordinator::full_before_table_copy_counter(),"fullAnchorRebuilds":crate::engine::duckdb_engine::full_anchor_rebuild_counter(),"fullWindowCounts":crate::engine::duckdb_engine::window_full_count_counter()})
}
