# Issue 282 native acceptance preparation

Status: final macOS Release matrix09 qualified (all 2500 warm operations and 15 independent cold opens); normal native preview is running with the fresh 2M × 20 project, selected A1000001 = 1000000, unedited. No human functional acceptance is recorded.

Build: `StatsPlayground Issue 282 Preview.app`, identifier `com.statsplayground.issue282.acceptance.final`, only `project-v5` enabled, benchmark frontend disabled and no UI-probe configuration. Functional Debug preview has the same source dd76cb32 as the qualified Release; preview timings are not qualification data.

Project fixture: `.superpowers/sdd/2026-10-16-issue-282-persistent-project/native-acceptance-final-2m.spprj`. This fresh owned fixture is separate from measured projects. [Qualified performance summary](../issue282-20261028-release-matrix-09/README.md).

Legacy fixture verification: explicit native migration to a separate ignored destination, CSV values 22/33 and unchanged original SHA-256 verified. Supplied CSV contains 10000 rows and three columns.

Worktree: `StatsPlayground.worktrees/282-persistent-project`, branch `codex/282-persistent-project`, target `dev`. Feature remains opt-in.

Planned functional checks:

1. Open a fresh owned 2M × 20 native fixture. Confirm Data and Report appear before selecting either; open Data and jump to A1000001. Its initial c0 value is1000000 (row labels are one-based).
2. Edit that cell to42424243, observe saving then saved, press Ctrl+S, close and reopen. Confirm the value survives, and persisted undo/redo restores the corresponding values without losing adjacent columns.
3. Edit Report, wait for saved, reopen and confirm content. Create/move/rename a folder, close/reopen and confirm assignments.
4. Import the supplied10k-row CSV directly into the open native project. Reopen it and verify10k rows and three columns; do not overwrite an existing table.
5. Save As to a new destination; confirm subsequent edits affect the copy while the source remains as it was at the snapshot boundary.
6. Open the supplied two-row legacy-v1 project through explicit conversion to a new destination. Confirm values22/33 and that the original legacy file remains intact.
7. Exercise close/switch during pending edits and any reported save failure; do not treat a failed persistence status as saved.

Known limits: native qualification here targets macOS. Windows/Linux, writable network shares, disk-full/permission fault coverage and future DuckDB storage upgrades are not qualified. Sorting/filter preparation and explicit imports, migration, Save As and exports can perform bulk work. Ordinary autosave and Ctrl+S are incremental durability operations. Main-process RSS excludes WebContent/GPU; the UI benchmark observes exact readiness plus two animation frames, not compositor presentation. No zero-wait guarantee.
