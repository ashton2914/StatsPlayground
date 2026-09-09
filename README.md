# StatsPlayground
An ultra-lightweight, open-source, and extensible data analysis tool.

## DataLink

SQLite DataLink supports read-only object discovery, schema inspection, 100-row
preview, selective snapshot import, append with exact schema matching, bounded
streaming, progress, cancellation, atomic rollback, and a structured result
summary with imported/skipped table counts and rows written.

SQLite import preserves BLOB values as DuckDB BLOB, keeps DATE/TIME values as
text, and rejects invalid numeric conversions without leaving partial data.
Failed and cancelled tasks report zero committed rows because the selected
tables are handled as one atomic task.
