# Issue 282 final macOS qualification

Qualified Release source: `dd76cb32bc150d708b34d80a0800bff5344ee31b`; base `3a362f6`. DuckDB v1.5.5, storage64. Raw [assessment](assessment.json). All2500 warm operations and15 independent cold opens pass; native timing2, UI observation2.

| Fixture | Cold catalog median ms | Warm catalog P95 | First window P95 | Scroll P95 | Durable edit P95 | Close P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 300k ×20 | 52 | 63 | 64 | 64 | 95 | 63 |
| 2M ×20 | 44 | 63 | 63 | 64 | 96 | 63 |
| 10M ×20 | 44 | 64 | 63 | 64 | 97 | 78 |
| 501 tables/10001 reports | — | 152 | 122 | 61 | 180 | 125 |
| 300k ×20,19 long-string columns | — | 63 | 102 | 96 | 131 | 64 |

Budgets: cold catalog median1000ms; warm P95 catalog500, window300, scroll100, edit200, unchanged close500ms. Each warm cell has100 observations. Each regular cold median has five separate native processes.

Cold cache: owned-file shared mmap/msync invalidation followed by mincore zero-residency confirmation and positive physical reads; no global cache settings changed. Readiness is exact visible/reference/durable state plus two animation frames, not compositor presentation. Direct Tauri native focus is true at both endpoints of every sample; DOM focus remains separate diagnostic data. Native duration is the union of matching foreground call intervals, with aggregate/overlap/raw intervals retained.

Durable edit: diskWriteBytes min/median/max 12288/16384/135168 bytes; walBytes min/median/max 11501/14172.5/133204 bytes; checkpointBytes min/median/max 0/0/0 bytes.
Unchanged close: diskWriteBytes min/median/max 6496256/7.97901e+06/13905920 bytes; walBytes min/median/max 0/0/0 bytes; checkpointBytes min/median/max 6402048/7.8848e+06/13811712 bytes.

Every measured operation reports zero archive restore/write, full database copy, full before-image copy, full anchor rebuild and full-window count counters; independent positive controls and process-kill recovery tests are retained. Normal row windows can scan DuckDB row groups: observed122880/122880/54240 physical rows on the300k fixture; bounded IPC is not a500-row backend scan guarantee.

Peak observed cache retention: 1500 rows, 12548384 estimated UTF-16 payload bytes. Two caches are limited to10000rows/128MiB combined, each5000rows/64MiB. Peak sampled main-process RSS 847282176bytes; WebContent/GPU excluded. Process I/O can include concurrent work; checkpoint bytes cover explicit CHECKPOINT only and exclude implicit shutdown writes.

Matrix08 is retained as unqualified despite all latency/logical gates passing: one close sample lost direct native focus. After a confirmed exclusive foreground interval, this matrix09 reran all original counts using the same source/binaries and fresh fixtures. Earlier failures and source snapshots remain retained; no sample replacement or retrospective report edits.

Verification:77 contract files,141 CT;1790 Rust library tests plus3 provenance/9MCP/6forbidden-work/3recovery tests pass. Rust excludes exactly the OLS failure reproduced on clean dev;21 tests ignored. Strict Clippy remains failing:200 current diagnostics match the204-diagnostic same-feature dev baseline with zero unmatched items.

Scope: macOS only. Feature remains opt-in. Windows/Linux, disk-full/permission faults, writable network shares and future engine storage upgrades are unqualified. Imports, explicit migration, Save As, export and global sort/filter/analysis may perform bulk work. No zero-wait guarantee. Native human acceptance and publication remain pending.
