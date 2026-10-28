//! Restore archived natural-order coordinates before exposing executable row history.
use crate::{engine::duckdb_engine::{DuckDbEngine,NATURAL_ORDER_STRIDE},error::AppError};
use super::row_order_update_boundary::{begin_row_order_update,RowOrderUpdateKind};

struct Entry {id:String,kind:String,operation:String,applied:bool}

/// Migration alone may scan/update all row coordinates. Ordinary open never calls this.
pub(crate) fn restore(engine:&DuckDbEngine)->Result<(),AppError> {
    let conn=engine.conn();
    let datasets=conn.prepare("SELECT DISTINCT dataset_id FROM _history_timeline WHERE storage_kind='row_delta' ORDER BY dataset_id")?.query_map([],|row|row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
    for dataset in datasets {
        let table=DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(&dataset));
        let map="_migration_current_row_order";
        conn.execute_batch(&format!("CREATE TEMP TABLE {map} AS SELECT _row_id AS row_id,NULL::HUGEINT AS row_order,_row_order AS serialized_order FROM {table}"))?;
        let entries=conn.prepare("SELECT change_set_id,storage_kind,operation,applied FROM _history_timeline WHERE dataset_id=? ORDER BY history_ordinal")?.query_map([&dataset],|row|Ok(Entry{id:row.get(0)?,kind:row.get(1)?,operation:row.get(2)?,applied:row.get(3)?}))?.collect::<Result<Vec<_>,_>>()?;
        // Before images of the undone suffix and after images of the applied
        // prefix jointly determine current coordinates, without replaying values.
        for entry in entries.iter().rev().filter(|entry|!entry.applied).chain(entries.iter().filter(|entry|entry.applied)) {
            if entry.kind=="full" {
                let side=if entry.applied{"after"}else{"before"};
                let snapshot=format!("_history_{side}_{}",entry.id.replace('-',"_"));
                let has_order:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name=? AND column_name='_row_order')",[&snapshot],|row|row.get(0))?;
                let order=if has_order{"snapshot._row_order"}else{"NULL::HUGEINT"};
                let snapshot=DuckDbEngine::quote_identifier(&snapshot);
                conn.execute_batch(&format!("UPDATE {map} AS target SET row_order={order} FROM {snapshot} snapshot WHERE target.row_id=snapshot._row_id"))?;
            }
            if entry.kind!="row_delta" {continue;}
            if (entry.applied&&entry.operation=="add_rows")||(!entry.applied&&entry.operation=="delete_rows") {
                conn.execute(&format!("UPDATE {map} AS target SET row_order=history.row_order FROM _history_row_deltas history WHERE history.change_set_id=? AND target.row_id=history.row_id"),[&entry.id])?;
            }
            let side=if entry.applied{"after_key"}else{"before_key"};
            conn.execute(&format!("UPDATE {map} AS target SET row_order=history.{side} FROM _history_natural_rebalances history WHERE history.change_set_id=? AND target.row_id=history.row_id"),[&entry.id])?;
        }
        // The serialized table is the independent visible-order authority. Fail
        // before publication if archived coordinates cannot reproduce its order.
        let mismatches:u64=conn.query_row(&format!("SELECT COUNT(*) FROM (SELECT serialized_order,CAST(ROW_NUMBER() OVER(ORDER BY COALESCE(row_order,CAST(row_id AS HUGEINT)*{NATURAL_ORDER_STRIDE}::HUGEINT),row_id) AS HUGEINT)*{NATURAL_ORDER_STRIDE}::HUGEINT AS expected FROM {map}) positions WHERE serialized_order IS DISTINCT FROM expected"),[],|row|row.get(0))?;
        if mismatches!=0 {return Err(AppError::InvalidParam("project_migration_row_order_unrecoverable".into()));}
        let mut update=begin_row_order_update(engine,&table,RowOrderUpdateKind::GlobalUnbounded)?;
        update.update_from_map(engine,&table,map)?;update.finish();
        engine.rebuild_natural_anchors(&dataset,engine.get_dataset_generation(&dataset)?)?;
        conn.execute_batch(&format!("DROP TABLE {map}"))?;
    }
    Ok(())
}
