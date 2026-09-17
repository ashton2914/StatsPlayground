# Table Navigation Arrow IPC Gate Design

Date: 2026-09-17

Status: review required before implementation

## Context

Task 8 requires a transport decision for 10,000,000-row table navigation. The current repository now contains a real macOS Tauri invoke benchmark path in `src/benchmarks/TableNavigationTransportBenchmark.tsx` and `scripts/measureTableNavigationTransport.mjs`, but the accepted Task 8 artifact set mixed two different methodologies:

- a CLI `performance_baseline --payload-stdout` capture, where stdout write time was labeled as `transferMs`;
- a browser replay artifact that reused one captured JSON payload across every measured run.

That evidence is still valid for backend snapshot size and browser replay decode/paint, but it is not sufficient to approve JSON as the actual Tauri IPC transport.

## Problem Statement

Arrow transport should remain a separate design gate until a fresh invoke-backed artifact set proves one of these outcomes:

1. JSON remains acceptable because backend JSON encode, real invoke delivery, and any honest frontend post-receive proxy remain within the Task 8 budget.
2. JSON is rejected because one of those slices materially exceeds the gate, justifying Arrow IPC implementation.

The current blocked state exists because the repository lacked a fresh, reviewable 5 warmup + 20 measured invoke artifact set under corrected labels at the time of Task 8 evidence correction.

## Non-Goals

- No Arrow IPC implementation in Task 8.
- No schema redesign beyond what an eventual Arrow transport would require.
- No replacement of the existing JSON path before the gate is re-run.

## Required Future Measurement

Before any Arrow implementation review, collect and persist both workloads below through the real Tauri invoke runner:

- 10,000,000 rows x 20 columns, 99% position, 5 warmup + 20 measured runs.
- 10,000,000 rows x 200 columns, 99% position, 5 warmup + 20 measured runs.

Persist:

- backend required benchmark JSON from `performance_baseline`;
- invoke-backed artifact with per-run `queryMs`, `diagnosticJsonEncodeMs`, `invokeWallMs`, `postBackendDeliveryMs`, `postReceiveJsonReparseMs`, `paintMs`, and `diagnosticJsonBytes`;
- exact command lines and machine facts;
- any `.error.json` artifact if the runner fails.

## Arrow Candidate Scope

If the rerun rejects JSON, the Arrow follow-up should stay narrowly scoped:

1. Add a versioned binary table-window response contract for navigation only.
2. Keep JSON metadata or a minimal JSON envelope only where required for compatibility.
3. Preserve dataset generation, session identity, and cancellation semantics.
4. Gate the new path behind an explicit transport version so cache keys cannot alias JSON and Arrow windows.
5. Re-run the same 20-column and 200-column benchmark matrix against the Arrow path before defaulting to it.

## Review Checklist

- The rerun uses real Tauri invoke, not CLI stdout or browser snapshot replay, for transport approval.
- Any remaining browser replay evidence is labeled strictly as snapshot decode/paint evidence.
- Runtime diagnostics stay opt-in so ordinary navigation does not pay duplicate JSON serialization overhead.
- JSON and Arrow cache entries remain transport-version isolated.