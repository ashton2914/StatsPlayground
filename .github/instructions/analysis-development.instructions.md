---
applyTo: "contracts/analysis/**,src/components/analysis/**/*.{ts,tsx},src/components/Workspace.tsx,src/types/analysis.ts,tests/analysis*.{ts,tsx},tests/distributionAnalysis*.ts,src-tauri/src/services/spprj_archive.rs"
---

# Analysis Development

Follow [docs/analysis-development-standard.md](../../docs/analysis-development-standard.md) for every Analysis change.

- Treat Distribution and Fit Y by X as the reference implementations for shared Analysis composition.
- Persist definitions and presentation only; Rust remains the statistical authority.
- Register every kind exhaustively in the descriptor, execution, view, editor, graph, and report layers.
- Keep full kind/document/dataset/request stale fencing and synchronous stale-result masking.
- Represent unsupported capabilities explicitly with `false` plus a `null` policy.
- Keep `contracts/analysis/kinds.v1.json`, TypeScript document types, and Rust archive validators in exact parity.
- Add focused contract and method coverage without a frontend statistical fallback, runtime plugin loader, or universal result schema.
- Require kind renderers to directly compose shared `AnalysisFrame`, `AnalysisStack`, `AnalysisText`, `AnalysisTable`, `AnalysisButton`, and `AnalysisGraph` primitives as applicable; never wrap a legacy report/view surface.
- Keep report typography, spacing, frames, tables, and actions on shared presentation tokens. Add structure contracts that reject raw result tables/actions and perform desktop plus narrow-width visual acceptance before completion.