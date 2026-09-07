---
applyTo: "**"
---

# StatsPlayground — Always-On Conventions

Cross-platform stats app: Tauri v2 + Rust + DuckDB backend, Vite + React 19 +
TypeScript + Zustand + ECharts 6 frontend. Path alias `@/` → `src/`.

## Non-negotiables
- **Rust errors**: return `Result<T, AppError>`; never `unwrap()`/`expect()` in
  non-test code. Map into an `AppError` variant (`Database`, `FileIO`, `Stats`,
  `InvalidParam`).
- **SQL**: parameterized/prepared statements only. Never build SQL by string
  concatenation of user input; type-check input before it reaches DuckDB.
- **File paths**: validate paths stay within allowed dirs; never expose absolute
  filesystem paths to the frontend.
- **IPC boundary**: a new Tauri command must be (1) delegated to a service,
  (2) registered in `tauri::generate_handler![...]` in `src-tauri/src/lib.rs`,
  and (3) wrapped in a `src/services/*.ts` object via `invoke<T>()`. Rust models
  use `#[serde(rename_all = "camelCase")]`; TS types mirror them in camelCase.
- **State**: use Zustand stores for shared state; keep components thin (no prop
  drilling beyond ~2 layers).

## Naming
- Rust: types PascalCase, fns/vars snake_case, consts SCREAMING_SNAKE_CASE.
- TS: components `PascalCase.tsx`, services/utils `camelCase.ts`, consts
  SCREAMING_SNAKE_CASE. Import order: React → third-party → `@/` internal →
  sibling → styles.

## Commits
Conventional Commits, e.g. `feat(data): add Parquet export`,
`fix(stats): correct sample stddev`. Work on the `dev` branch; don't push unless
asked.

## Verify before claiming done
- Frontend: `npx vite build 2>&1 | Select-Object -Last 3`
- Backend: `cargo build` / `cargo clippy` / `cargo test` in `src-tauri/`.

For end-to-end feature work see the `statsplayground-dev` skill; for chart work
in `src/graphCore/` see the `graphcore-echarts` skill.

For Analysis kinds, follow `docs/analysis-development-standard.md` and the
scoped `.github/instructions/analysis-development.instructions.md` rules.
