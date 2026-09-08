---
name: statsplayground-dev
description: 'AI-assisted development workflow for the StatsPlayground desktop app (Tauri v2 + Rust + DuckDB backend, Vite + React 19 + TypeScript + Zustand frontend, ECharts charts). USE FOR: adding or changing a feature end-to-end across Rust commands and the React UI, wiring a new Tauri IPC command, adding a Zustand store or service wrapper, editing DuckDB/stats logic, working on ECharts graphs in graphCore, verifying the build, following repo commit conventions. Keywords: StatsPlayground, Tauri command, invoke, DuckDB, DataService, Zustand store, ECharts transform, add IPC, backend frontend contract. DO NOT USE FOR: generic React/Rust questions unrelated to this repo, or environment setup (see docs/development.md).'
argument-hint: 'Describe the feature or change you want (e.g. "add a command to export a dataset to Parquet")'
---

# StatsPlayground — AI-Assisted Development

Cross-platform desktop stats tool. **Backend**: Tauri v2 (Rust) with a DuckDB
engine and statrs/nalgebra compute. **Frontend**: Vite + React 19 + TypeScript,
Zustand stores, ECharts 6 visualization. All backend calls cross a typed Tauri
IPC boundary.

## When to Use
- Implementing a feature that spans Rust ↔ React (the common case here).
- Adding/modifying a Tauri command, a `src/services/*` wrapper, or a Zustand store.
- Touching DuckDB queries, stats math, or ECharts transforms in `src/graphCore/`.
- Any time you finish a change and need to build + commit per repo convention.

## Architecture Map
| Layer | Path | Notes |
|-------|------|-------|
| Rust command handlers | [src-tauri/src/commands/](../../../src-tauri/src/commands/) | Thin `#[tauri::command]` fns, delegate to services |
| Rust services | [src-tauri/src/services/](../../../src-tauri/src/services/) | Business logic, own the DuckDB/stats work |
| DuckDB engine | [src-tauri/src/engine/duckdb_engine.rs](../../../src-tauri/src/engine/duckdb_engine.rs) | Connection + query execution |
| Rust models | [src-tauri/src/models/](../../../src-tauri/src/models/) | `serde` structs shared over IPC |
| Command registration | [src-tauri/src/lib.rs](../../../src-tauri/src/lib.rs) | `tauri::generate_handler![...]` |
| Error type | [src-tauri/src/error.rs](../../../src-tauri/src/error.rs) | `AppError` (thiserror), serialized to string |
| TS IPC wrappers | [src/services/](../../../src/services/) | One object per domain, wraps `invoke<T>()` |
| TS types | [src/types/](../../../src/types/) | Must mirror Rust models (camelCase) |
| Zustand stores | [src/stores/](../../../src/stores/) | State + actions; call services |
| React components | [src/components/](../../../src/components/) | Function components + hooks |
| Charts | [src/graphCore/](../../../src/graphCore/) | ECharts spec built in `transform.ts` |

Path alias: `@/` → `src/` (see [vite.config.ts](../../../vite.config.ts)).

## Add an IPC Command End-to-End
Follow every step; skipping registration or the TS type is the usual failure.

1. **Rust model** (if new data crosses the boundary): add a `serde`-derived
   struct in `src-tauri/src/models/`. Use `#[serde(rename_all = "camelCase")]`
   so it matches TS naming.
2. **Rust service**: put the real logic in the matching `services/*_service.rs`.
   Return `Result<T, AppError>`. Never `unwrap()` outside tests — map errors into
   an `AppError` variant (`Database`, `FileIO`, `Stats`, `InvalidParam`).
3. **Rust command**: add a thin `#[tauri::command]` fn in the matching
   `commands/*_commands.rs` that takes `state: State<'_, AppState>`, builds the
   service, and delegates. Command args are `snake_case` in Rust.
4. **Register**: add the fn to `tauri::generate_handler![...]` in `lib.rs`.
   Omitting this compiles fine but the frontend gets "command not found" at runtime.
5. **TS type**: add/extend the interface in `src/types/` to mirror the Rust model
   (fields in `camelCase`).
6. **TS service**: add a method to the relevant `src/services/*.ts` object:
   `invoke<ReturnType>("command_name", { argInCamelCase })`. Tauri auto-converts
   the JS `camelCase` keys to the Rust `snake_case` params — pass camelCase.
7. **Store/UI**: call the service from a Zustand store action (keep components thin;
   avoid prop drilling beyond ~2 layers) and wire it into the component.

## Conventions (enforced)
- **Rust**: edition 2021, `rustfmt` default, `clippy -D warnings`, `thiserror`
  errors, no `unwrap()` in non-test code, `#[cfg(test)]` unit tests per service.
- **TS/React**: strict mode, function components + hooks, Zustand for state.
  Component files `PascalCase.tsx`, services/utils `camelCase.ts`, constants
  `SCREAMING_SNAKE_CASE`. Import order: React → third-party → internal (`@/`) →
  sibling → styles.
- **Security**: parameterized SQL only (no string-built queries), validate file
  paths stay in allowed dirs, never expose absolute FS paths to the frontend,
  type-check user input before it reaches DuckDB.
- **Commits**: Conventional Commits, e.g. `feat(data): add Parquet export`,
  `fix(stats): correct sample stddev`.

## Verify & Commit (do after every change)
1. **Frontend build check** (fast, ~6–7s):
   `npx vite build 2>&1 | Select-Object -Last 3`
2. **Rust change**: also run `cargo build` (or `cargo clippy`) in `src-tauri/`.
3. **Rust tests**: each service/engine module has `#[cfg(test)]` unit tests —
   run `cargo test` in `src-tauri/` after backend changes, and add tests for new
   service logic. (No frontend test runner is configured; rely on the build check.)
4. **Full app run** when UI/IPC changed: `cargo tauri dev`.
5. **Auto-commit each completed, building step** without asking:
   `git add -A; git commit -m "<conventional message>"`. Do **not** push unless
   explicitly asked. Working branch: `dev`.

## Add an Analysis Kind

Follow [docs/analysis-development-standard.md](../../../docs/analysis-development-standard.md).

1. Add the manifest identity and discriminated `AnalysisDocument` union member.
2. Register descriptors, execution, synchronous view rendering, editor adaptation,
   graph persistence, and report policy exhaustively.
3. Keep Rust as the compute authority and preserve the full Analysis stale fence.
4. Add an explicit Rust archive validator selected by kind and definition identity.
5. Declare unsupported graph/report capabilities as `false` with a `null` policy.
6. Extend the registration contract and focused kind suite, then run the Analysis gate.

## ECharts / graphCore Work
Chart specs are built in [src/graphCore/transform.ts](../../../src/graphCore/transform.ts).
Custom series and histogram bin math have bitten this repo repeatedly. **Before
editing anything under `src/graphCore/`, use the `graphcore-echarts` skill** — it
covers the custom-series rules (single shape, no `encode`, `clip: true`, ordinal
vs string) and the histogram bin-to-tick alignment math (MODE A/C, niceStep
ladder, over-render, per-cat normalization).

## CSS Gotcha
On cells using a custom `background-clip` (spreadsheet grid), override with
`background-color:` — never the `background:` shorthand, which resets
`background-clip` to `border-box` and erases grid lines.
