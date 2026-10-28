use super::{project_cell_mutation, project_history_group, table_delta_mutation};
use crate::{
    engine::duckdb_engine::{DuckDbEngine, UserColumnDescriptor},
    error::AppError,
    models::{project_persistence::ProjectPasteRequest, table::PasteChangeSetResult},
};

fn unique_name(base: &str, names: &[String], exclude: Option<usize>) -> String {
    let free = |candidate: &str| {
        !names
            .iter()
            .enumerate()
            .any(|(i, n)| Some(i) != exclude && n.eq_ignore_ascii_case(candidate))
    };
    if free(base) {
        return base.into();
    }
    for suffix in 2.. {
        let candidate = format!("{base}-{suffix}");
        if free(&candidate) {
            return candidate;
        }
    }
    unreachable!()
}

/// Caller owns the single project transaction, including settings and receipts.
pub(crate) fn paste_in_transaction(
    engine: &DuckDbEngine,
    request: &ProjectPasteRequest,
) -> Result<PasteChangeSetResult, AppError> {
    let dataset = &request.dataset_id;
    let columns = engine.get_user_column_descriptors(dataset)?;
    if columns
        .iter()
        .map(|c| c.column_id.as_str())
        .ne(request.column_ids.iter().map(String::as_str))
    {
        return Err(AppError::InvalidParam("project_columns_stale".into()));
    }
    let width = request.rows.iter().map(Vec::len).max().unwrap_or(0);
    let end = request
        .start_col
        .checked_add(width)
        .ok_or_else(|| AppError::InvalidParam("paste_column_overflow".into()))?;
    let row_end = request
        .start_row
        .checked_add(request.rows.len())
        .ok_or_else(|| AppError::InvalidParam("paste_row_overflow".into()))?;
    if width == 0
        || request.rows.is_empty()
        || width
            .checked_mul(request.rows.len())
            .is_none_or(|n| n > 100_000)
        || end > 1000
        || request
            .header_names
            .as_ref()
            .is_some_and(|h| h.len() != width)
    {
        return Err(AppError::InvalidParam("paste_dimensions_invalid".into()));
    }
    let existing_end = end.min(columns.len());
    if request.start_col < existing_end {
        engine.reject_calculated_column_writes(
            dataset,
            columns[request.start_col..existing_end]
                .iter()
                .map(|c| c.name.as_str()),
        )?;
    }
    if let Some(updates) = project_cell_mutation::compact_paste_updates_with_row_ids(
        engine,
        dataset,
        request.start_row,
        request.start_col,
        &request.rows,
        request.header_names.as_deref(),
        &request.col_types,
        request.row_ids.as_deref(),
    )? {
        let result = project_cell_mutation::update_cells_compact_in_transaction(
            engine,
            dataset,
            &updates,
            request.expected_generation,
        )?;
        return result_meta(engine, dataset, result.change_set_id.unwrap_or_default());
    }
    let mut children = Vec::new();
    let mut names = columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>();
    // Append only missing columns. Stable IDs and native types survive undo/redo.
    if end > columns.len() {
        let mut added = Vec::new();
        for index in columns.len()..end {
            let offset = index.checked_sub(request.start_col);
            let proposed = offset
                .and_then(|c| request.header_names.as_ref().and_then(|h| h.get(c)))
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());
            let name = proposed
                .map(|s| unique_name(s, &names, None))
                .unwrap_or_else(|| DuckDbEngine::generate_col_name(&names));
            let sql_type = engine.canonicalize_column_type_for_create(
                offset
                    .and_then(|c| request.col_types.get(c))
                    .map(String::as_str)
                    .unwrap_or("VARCHAR"),
            )?;
            names.push(name.clone());
            added.push(UserColumnDescriptor {
                column_id: uuid::Uuid::new_v4().to_string(),
                col_index: index as i32,
                name,
                sql_type,
            });
        }
        let result = table_delta_mutation::add_columns_compact_in_transaction(
            engine,
            dataset,
            &added,
            columns.len() as i32,
            engine.get_dataset_generation(dataset)?,
        )?;
        children.push(result.change_set_id);
    }
    for offset in 0..width {
        let index = request.start_col + offset;
        let Some(column) = columns.get(index) else {
            continue;
        };
        let requested = engine.canonicalize_column_type_for_create(
            request
                .col_types
                .get(offset)
                .map(String::as_str)
                .unwrap_or("VARCHAR"),
        )?;
        if requested == column.sql_type {
            continue;
        }
        let table = DuckDbEngine::quote_identifier(&DuckDbEngine::internal_table_name(dataset));
        let name = DuckDbEngine::quote_identifier(&column.name);
        let has_data: bool = engine.conn().query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {name} IS NOT NULL)"),
            [],
            |r| r.get(0),
        )?;
        if !has_data {
            children.push(table_delta_mutation::promote_empty_column_in_transaction(
                engine,
                dataset,
                &column.column_id,
                &requested,
                engine.get_dataset_generation(dataset)?,
            )?);
        }
    }
    if let Some(headers) = &request.header_names {
        for (offset, header) in headers.iter().enumerate() {
            let index = request.start_col + offset;
            if index >= columns.len() || header.trim().is_empty() || names[index] == header.trim() {
                continue;
            }
            let name = unique_name(header.trim(), &names, Some(index));
            children.push(table_delta_mutation::rename_column_compact_in_transaction(
                engine,
                dataset,
                &names[index],
                &name,
                engine.get_dataset_generation(dataset)?,
            )?);
            names[index] = name;
        }
    }
    let meta = engine.get_dataset_meta(dataset)?;
    if request.row_ids.is_none() && row_end as u128 > meta.row_count.max(0) as u128 {
        let count = row_end
            .checked_sub(meta.row_count.max(0) as usize)
            .ok_or_else(|| AppError::InvalidParam("paste_row_overflow".into()))?;
        let result = table_delta_mutation::add_rows_compact_in_transaction(
            engine,
            dataset,
            count,
            None,
            meta.generation,
        )?;
        children.push(result.change_set_id);
    }
    // Schema changes are complete; infer no further types while resolving this bounded window.
    let current = engine.get_user_column_descriptors(dataset)?;
    let types = current[request.start_col..end]
        .iter()
        .map(|c| c.sql_type.clone())
        .collect::<Vec<_>>();
    let updates = project_cell_mutation::compact_paste_updates_with_row_ids(
        engine,
        dataset,
        request.start_row,
        request.start_col,
        &request.rows,
        None,
        &types,
        request.row_ids.as_deref(),
    )?
    .ok_or_else(|| AppError::InvalidParam("project_paste_window_unavailable".into()))?;
    let result = project_cell_mutation::update_cells_compact_in_transaction(
        engine,
        dataset,
        &updates,
        engine.get_dataset_generation(dataset)?,
    )?;
    if let Some(id) = result.change_set_id {
        children.push(id);
    }
    let root = project_history_group::record(engine, &children, "paste")?;
    result_meta(engine, dataset, root)
}

fn result_meta(
    engine: &DuckDbEngine,
    dataset: &str,
    change_set_id: String,
) -> Result<PasteChangeSetResult, AppError> {
    let meta = engine.get_dataset_meta(dataset)?;
    Ok(PasteChangeSetResult {
        change_set_id,
        generation: Some(meta.generation),
        row_count: Some(meta.row_count),
        column_count: Some(meta.col_count),
    })
}
