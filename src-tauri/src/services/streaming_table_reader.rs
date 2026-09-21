use std::fmt;
use std::io::Read;

use serde::de::{DeserializeSeed, Error as _, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::Deserializer;
use serde_json::Value;

use crate::error::AppError;
use crate::services::spprj_archive::TableColumn;

pub(crate) const STREAM_ROW_TARGET_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct StreamedTableHeader {
    pub id: String,
    pub name: String,
    pub source_type: String,
    pub version: String,
    pub columns: Vec<TableColumn>,
}

pub(crate) enum TableHeaderScan {
    Canonical(StreamedTableHeader),
    RequiresBufferedCompatibility,
}

pub(crate) trait TableBatchSink {
    fn begin_table(&mut self, header: &StreamedTableHeader) -> Result<(), AppError>;
    fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError>;
    fn finish_table(&mut self, row_count: usize) -> Result<(), AppError>;
}

pub(crate) fn scan_table_header<R: Read>(reader: R) -> Result<TableHeaderScan, AppError> {
    let mut scan = None;
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let result = deserializer.deserialize_map(HeaderScanVisitor { scan: &mut scan });
    if let Some(scan) = scan {
        return Ok(scan);
    }
    result.map_err(json_file_error)?;
    Err(AppError::FileIO(
        "table document is missing rows".to_string(),
    ))
}

pub(crate) fn stream_table_rows<R: Read, S: TableBatchSink>(
    reader: R,
    expected: &StreamedTableHeader,
    sink: &mut S,
) -> Result<usize, AppError> {
    let mut sink_error = None;
    let mut deserializer = serde_json::Deserializer::from_reader(reader);
    let result = deserializer.deserialize_map(TableStreamVisitor {
        expected,
        sink,
        sink_error: &mut sink_error,
    });

    if let Some(error) = sink_error {
        return Err(error);
    }

    let row_count = result.map_err(json_file_error)?;
    deserializer.end().map_err(json_file_error)?;
    Ok(row_count)
}

fn set_once<E, T>(slot: &mut Option<T>, value: T, field: &'static str) -> Result<(), E>
where
    E: serde::de::Error,
{
    if slot.is_some() {
        return Err(E::duplicate_field(field));
    }
    *slot = Some(value);
    Ok(())
}

struct HeaderScanVisitor<'a> {
    scan: &'a mut Option<TableHeaderScan>,
}

impl<'de> Visitor<'de> for HeaderScanVisitor<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a table document object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut id = None;
        let mut name = None;
        let mut source_type = None;
        let mut version = None;
        let mut columns = None;

        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "id" => set_once(&mut id, map.next_value()?, "id")?,
                "name" => set_once(&mut name, map.next_value()?, "name")?,
                "sourceType" => set_once(&mut source_type, map.next_value()?, "sourceType")?,
                "version" => set_once(&mut version, map.next_value()?, "version")?,
                "columns" => set_once(&mut columns, map.next_value()?, "columns")?,
                "rows" => {
                    let (Some(id), Some(name), Some(source_type), Some(version), Some(columns)) =
                        (id, name, source_type, version, columns)
                    else {
                        *self.scan = Some(TableHeaderScan::RequiresBufferedCompatibility);
                        return Err(A::Error::custom("header scan complete"));
                    };
                    *self.scan = Some(TableHeaderScan::Canonical(StreamedTableHeader {
                        id,
                        name,
                        source_type,
                        version,
                        columns,
                    }));
                    return Err(A::Error::custom("header scan complete"));
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }

        Err(A::Error::missing_field("rows"))
    }
}

struct TableStreamVisitor<'a, S> {
    expected: &'a StreamedTableHeader,
    sink: &'a mut S,
    sink_error: &'a mut Option<AppError>,
}

impl<'de, S: TableBatchSink> Visitor<'de> for TableStreamVisitor<'_, S> {
    type Value = usize;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a canonical table document object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut id = None;
        let mut name = None;
        let mut source_type = None;
        let mut version = None;
        let mut columns = None;
        let mut row_count = None;
        let mut started = false;

        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "id" => set_once(&mut id, map.next_value()?, "id")?,
                "name" => set_once(&mut name, map.next_value()?, "name")?,
                "sourceType" => set_once(&mut source_type, map.next_value()?, "sourceType")?,
                "version" => set_once(&mut version, map.next_value()?, "version")?,
                "columns" => set_once(&mut columns, map.next_value()?, "columns")?,
                "rows" => {
                    if row_count.is_some() {
                        return Err(A::Error::duplicate_field("rows"));
                    }
                    let actual = StreamedTableHeader {
                        id: id.clone().ok_or_else(|| A::Error::missing_field("id"))?,
                        name: name
                            .clone()
                            .ok_or_else(|| A::Error::missing_field("name"))?,
                        source_type: source_type
                            .clone()
                            .ok_or_else(|| A::Error::missing_field("sourceType"))?,
                        version: version
                            .clone()
                            .ok_or_else(|| A::Error::missing_field("version"))?,
                        columns: columns
                            .clone()
                            .ok_or_else(|| A::Error::missing_field("columns"))?,
                    };
                    verify_header::<A::Error>(&actual, self.expected)?;
                    if let Err(error) = self.sink.begin_table(self.expected) {
                        *self.sink_error = Some(error);
                        return Err(A::Error::custom("table sink failed"));
                    }
                    started = true;
                    let count = map.next_value_seed(RowsSeed {
                        sink: self.sink,
                        sink_error: self.sink_error,
                    })?;
                    row_count = Some(count);
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }

        let count = row_count.ok_or_else(|| A::Error::missing_field("rows"))?;
        if !started {
            return Err(A::Error::custom("table sink was not started"));
        }
        if let Err(error) = self.sink.finish_table(count) {
            *self.sink_error = Some(error);
            return Err(A::Error::custom("table sink failed"));
        }
        Ok(count)
    }
}

fn verify_header<E>(actual: &StreamedTableHeader, expected: &StreamedTableHeader) -> Result<(), E>
where
    E: serde::de::Error,
{
    let actual_columns = serde_json::to_value(&actual.columns).map_err(E::custom)?;
    let expected_columns = serde_json::to_value(&expected.columns).map_err(E::custom)?;
    if actual.id != expected.id
        || actual.name != expected.name
        || actual.source_type != expected.source_type
        || actual.version != expected.version
        || actual_columns != expected_columns
    {
        return Err(E::custom("table header does not match the scanned header"));
    }
    Ok(())
}

struct RowsSeed<'a, S> {
    sink: &'a mut S,
    sink_error: &'a mut Option<AppError>,
}

impl<'de, S: TableBatchSink> DeserializeSeed<'de> for RowsSeed<'_, S> {
    type Value = usize;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        deserializer.deserialize_seq(RowsVisitor {
            sink: self.sink,
            sink_error: self.sink_error,
        })
    }
}

struct RowsVisitor<'a, S> {
    sink: &'a mut S,
    sink_error: &'a mut Option<AppError>,
}

impl<'de, S: TableBatchSink> Visitor<'de> for RowsVisitor<'_, S> {
    type Value = usize;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an array of table rows")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut batch: Vec<Vec<Value>> = Vec::new();
        let mut batch_bytes = 0usize;
        let mut row_count = 0usize;

        while let Some(row) = sequence.next_element::<Vec<Value>>()? {
            let row_bytes = row
                .iter()
                .map(estimate_json_value_bytes)
                .fold(0usize, usize::saturating_add);

            if !batch.is_empty() && batch_bytes.saturating_add(row_bytes) > STREAM_ROW_TARGET_BYTES
            {
                append_batch::<A::Error, S>(self.sink, self.sink_error, &batch)?;
                batch.clear();
                batch_bytes = 0;
            }

            batch_bytes = batch_bytes.saturating_add(row_bytes);
            batch.push(row);
            row_count = row_count.saturating_add(1);

            if batch_bytes >= STREAM_ROW_TARGET_BYTES {
                append_batch::<A::Error, S>(self.sink, self.sink_error, &batch)?;
                batch.clear();
                batch_bytes = 0;
            }
        }

        if !batch.is_empty() {
            append_batch::<A::Error, S>(self.sink, self.sink_error, &batch)?;
        }
        Ok(row_count)
    }
}

fn append_batch<E, S: TableBatchSink>(
    sink: &mut S,
    sink_error: &mut Option<AppError>,
    rows: &[Vec<Value>],
) -> Result<(), E>
where
    E: serde::de::Error,
{
    if let Err(error) = sink.append_rows(rows) {
        *sink_error = Some(error);
        return Err(E::custom("table sink failed"));
    }
    Ok(())
}

fn estimate_json_value_bytes(value: &Value) -> usize {
    match value {
        Value::Null => 0,
        Value::Bool(_) | Value::Number(_) => std::mem::size_of::<Value>(),
        Value::String(value) => std::mem::size_of::<Value>() + value.capacity(),
        Value::Array(values) => std::mem::size_of::<Value>()
            .saturating_add(
                values
                    .capacity()
                    .saturating_mul(std::mem::size_of::<Value>()),
            )
            .saturating_add(
                values
                    .iter()
                    .map(estimate_json_value_bytes)
                    .fold(0usize, usize::saturating_add),
            ),
        Value::Object(values) => std::mem::size_of::<Value>().saturating_add(
            values
                .iter()
                .map(|(key, value)| {
                    key.capacity()
                        .saturating_add(estimate_json_value_bytes(value))
                })
                .fold(0usize, usize::saturating_add),
        ),
    }
}

fn json_file_error(error: serde_json::Error) -> AppError {
    AppError::FileIO(error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;
    use crate::error::AppError;

    #[derive(Default)]
    struct RecordingSink {
        started: usize,
        rows: Vec<Vec<Value>>,
        finished: Vec<usize>,
        batch_sizes: Vec<usize>,
        max_batch_estimate: usize,
        max_row_estimate: usize,
    }

    impl TableBatchSink for RecordingSink {
        fn begin_table(&mut self, _header: &StreamedTableHeader) -> Result<(), AppError> {
            self.started += 1;
            Ok(())
        }

        fn append_rows(&mut self, rows: &[Vec<Value>]) -> Result<(), AppError> {
            self.batch_sizes.push(rows.len());
            self.max_batch_estimate = self.max_batch_estimate.max(
                rows.iter()
                    .flatten()
                    .map(estimate_json_value_bytes)
                    .sum::<usize>(),
            );
            self.max_row_estimate = self.max_row_estimate.max(
                rows.iter()
                    .map(|row| row.iter().map(estimate_json_value_bytes).sum::<usize>())
                    .max()
                    .unwrap_or_default(),
            );
            self.rows.extend_from_slice(rows);
            Ok(())
        }

        fn finish_table(&mut self, row_count: usize) -> Result<(), AppError> {
            self.finished.push(row_count);
            Ok(())
        }
    }

    impl RecordingSink {
        fn row_ids(&self) -> Vec<i64> {
            self.rows
                .iter()
                .map(|row| row[0].as_i64().unwrap())
                .collect()
        }
    }

    fn canonical_table_json(rows: usize) -> Vec<u8> {
        let rows = (1..=rows)
            .map(|row_id| json!([row_id, row_id as f64 / 2.0]))
            .collect::<Vec<_>>();
        format!(
            r#"{{"id":"table-1","name":"Data","sourceType":"manual","version":"3","columns":[{{"name":"x","colType":"DOUBLE"}}],"rows":{}}}"#,
            serde_json::to_string(&rows).unwrap()
        )
        .into_bytes()
    }

    fn canonical_header(json: &[u8]) -> StreamedTableHeader {
        match scan_table_header(json).unwrap() {
            TableHeaderScan::Canonical(header) => header,
            TableHeaderScan::RequiresBufferedCompatibility => panic!("canonical table"),
        }
    }

    #[test]
    fn canonical_table_streams_header_and_bounded_row_batches() {
        let json = canonical_table_json(12_000);
        let header = canonical_header(&json);
        let mut sink = RecordingSink::default();
        let rows = stream_table_rows(json.as_slice(), &header, &mut sink).unwrap();

        assert_eq!(rows, 12_000);
        assert_eq!(sink.started, 1);
        assert_eq!(sink.finished, vec![12_000]);
        assert_eq!(sink.row_ids(), (1_i64..=12_000).collect::<Vec<_>>());
        assert!(sink.max_batch_estimate <= STREAM_ROW_TARGET_BYTES + sink.max_row_estimate);
    }

    #[test]
    fn rows_before_columns_selects_buffered_compatibility() {
        let json = br#"{
          "id":"table-1","rows":[[1,2.0]],"name":"Data",
          "sourceType":"manual","version":"3","columns":[{"name":"x","colType":"DOUBLE"}]
        }"#;
        assert!(matches!(
            scan_table_header(&json[..]).unwrap(),
            TableHeaderScan::RequiresBufferedCompatibility
        ));
    }

    #[test]
    fn every_missing_required_header_field_selects_buffered_compatibility() {
        for json in [
            br#"{"name":"Data","sourceType":"manual","version":"3","columns":[],"rows":[]}"#
                .as_slice(),
            br#"{"id":"table-1","sourceType":"manual","version":"3","columns":[],"rows":[]}"#
                .as_slice(),
            br#"{"id":"table-1","name":"Data","version":"3","columns":[],"rows":[]}"#.as_slice(),
            br#"{"id":"table-1","name":"Data","sourceType":"manual","columns":[],"rows":[]}"#
                .as_slice(),
            br#"{"id":"table-1","name":"Data","sourceType":"manual","version":"3","rows":[]}"#
                .as_slice(),
        ] {
            assert!(matches!(
                scan_table_header(json).unwrap(),
                TableHeaderScan::RequiresBufferedCompatibility
            ));
        }
    }

    #[test]
    fn duplicate_header_field_is_rejected() {
        let json = br#"{
          "id":"table-1","name":"Data","name":"Other","sourceType":"manual",
          "version":"3","columns":[],"rows":[]
        }"#;
        assert!(matches!(
            scan_table_header(&json[..]),
            Err(AppError::FileIO(_))
        ));
    }

    #[test]
    fn malformed_row_is_rejected() {
        let json = br#"{
          "id":"table-1","name":"Data","sourceType":"manual","version":"3",
          "columns":[],"rows":[[1],oops]
        }"#;
        let header = canonical_header(json);
        assert!(matches!(
            stream_table_rows(&json[..], &header, &mut RecordingSink::default()).unwrap_err(),
            AppError::FileIO(_)
        ));
    }

    #[test]
    fn streaming_table_rejects_trailing_json() {
        let canonical = canonical_table_json(10);
        let header = canonical_header(&canonical);
        let mut json = canonical;
        json.extend_from_slice(b"{}");
        let error =
            stream_table_rows(json.as_slice(), &header, &mut RecordingSink::default()).unwrap_err();
        assert!(matches!(error, AppError::FileIO(_)));
    }

    #[test]
    fn sink_failure_preserves_original_app_error() {
        struct FailingSink;
        impl TableBatchSink for FailingSink {
            fn begin_table(&mut self, _header: &StreamedTableHeader) -> Result<(), AppError> {
                Ok(())
            }

            fn append_rows(&mut self, _rows: &[Vec<Value>]) -> Result<(), AppError> {
                Err(AppError::Database("sink sentinel".into()))
            }

            fn finish_table(&mut self, _row_count: usize) -> Result<(), AppError> {
                Ok(())
            }
        }

        let json = canonical_table_json(1);
        let header = canonical_header(&json);
        let error = stream_table_rows(json.as_slice(), &header, &mut FailingSink).unwrap_err();
        assert!(matches!(
            error,
            AppError::Database(message) if message == "sink sentinel"
        ));
    }

    #[test]
    fn oversized_single_row_is_delivered_alone() {
        let oversized = "x".repeat(STREAM_ROW_TARGET_BYTES + 1);
        let rows = json!([[oversized], ["tail"]]);
        let json = format!(
            r#"{{"id":"table-1","name":"Data","sourceType":"manual","version":"3","columns":[{{"name":"x","colType":"TEXT"}}],"rows":{rows}}}"#
        )
        .into_bytes();
        let header = canonical_header(&json);
        let mut sink = RecordingSink::default();

        assert_eq!(
            stream_table_rows(json.as_slice(), &header, &mut sink).unwrap(),
            2
        );
        assert_eq!(sink.batch_sizes, vec![1, 1]);
        assert!(sink.max_row_estimate > STREAM_ROW_TARGET_BYTES);
        assert_eq!(sink.rows[1], vec![json!("tail")]);
    }
}
