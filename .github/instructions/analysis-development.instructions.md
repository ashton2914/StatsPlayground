---
applyTo: "contracts/analysis/**,src/components/analysis/**/*.{ts,tsx},src/components/Workspace.tsx,src/types/analysis.ts,tests/analysis*.{ts,tsx},tests/distributionAnalysis*.ts,src-tauri/src/services/spprj_archive.rs"
---

# Analysis Development

Follow [docs/analysis-development-standard.md](../../docs/analysis-development-standard.md) for every Analysis change.

- Treat Distribution as the reference implementation and the only current Analysis kind.
- Persist definitions and presentation only; Rust remains the statistical authority.
- Register every kind exhaustively in the descriptor, execution, view, editor, graph, and report layers.
- Keep full kind/document/dataset/request stale fencing and synchronous stale-result masking.
- Represent unsupported capabilities explicitly with `false` plus a `null` policy.
- Keep `contracts/analysis/kinds.v1.json`, TypeScript document types, and Rust archive validators in exact parity.
- Add focused contract and method coverage without a frontend statistical fallback, runtime plugin loader, or universal result schema.