# Pixel renderer: #261 UI integration

This selective port brings the interaction and layout improvements from #261 (`5df942c`, UI portions of `7808135`) onto the full-source pixel renderer at `b3a5aa3`. The follow-up V3 layer port shares the Scatter and Line option editors with the legacy Graph Builder.

## Behavior

- Numeric X/Y labels use the interface font and native axis metadata; duplicate bitmap labels and axis titles are removed.
- Zoom-out and pan keep the last coherent frame when a transformed preview would expose empty regions. Replacement failures have bounded recovery and safe diagnostics.
- Reset and render status live in the toolbar, outside the plot. Empty axes show a drag hint.
- Left/right rail widths and column/layer/legend/style splits support pointer and keyboard resizing, persistence, and double-click reset.
- Changing pure-line policy rebuilds the appropriate source cache before restoring the camera, including an unsettled gesture and successive mode changes.

## Performance boundaries

The initial layout-only comparison below predates V3 layers. The V3 integration preserves the Scatter occupancy partition/raster algorithm, physical-pixel radius, exact camera identity, and backend float round-trip handling. It adds full-source layer retention, group-aware raw records, explicit resource accounting, and a cached jitter index. Core source hashes consequently differ from the initial layout-only port.

A deterministic 3,000,000-point debug service comparison uses 720×720 frames and 25 requests: cold construction, cached radii 1/5, then zoom/pan at both radii. Each warm frame asserts zero source projection queries; radius-only changes assert zero source-point inspections and center-mask reuse. Frames use a synthetic readback, so these are CPU service/raster timings, excluding GPU, IPC, decoding, UI, and native display latency.

| Phase | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Cold construction, one sample | 5438.0 | 5788.9 |
| Cached full view, radius 1, median of 6 | 29.0 | 29.2 |
| Cached full view, radius 5, median of 6 | 264.3 | 268.7 |
| Zoom/pan, radius 1, median of 6 | 31.1 | 30.1 |
| Zoom/pan, radius 5, median of 6 | 273.7 | 269.2 |

This small paired run shows no obvious warm-path regression. It is not a sub-second guarantee for arbitrary datasets or cold indexing; billion-point timings require the dedicated stress measurements.

Run the explicit guard with:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol graph_new_pixel_ux_performance_guard --lib -- --ignored --nocapture
```

## Verification

- Rust graph regression: 201 passed; the explicit performance guard passed separately.
- Frontend service contract, layout-preference store, TypeScript build, and Vite build passed.
- Browser integration: 124 tests passed across Graph Builder, Workspace persistence, shared splitters, and legacy splitters; a final layer-card overflow check and four affected layout checks passed after the CSS adjustment.
- Independent review checked actual source differences and protected module hashes; its rapid-mode-switch finding was fixed and covered by a delayed-frame regression test.
- Final desktop bundle: a 3,000,000-point grouped project rendered with 0 excluded rows. Radius expansion, group visibility, zoom-out, persisted rail resize, reset, and unclipped controls were exercised. Binary/source hashes and validation logs accompany the local build.

## Independent Scatter and Line layers (V3)

New documents contain one Scatter with Summary Statistic=None and no hidden mean line. The + menu adds independent Line/Time Series cards. Both graph builders use the same option editors and defaults: Scatter has summary, interval, jitter and jitter-limit controls; Line has row order, connection, summary, fill, intervals and missing-data controls. Scatter also retains the physical-pixel radius slider.

V1/V2 documents migrate to explicit cards; an existing enabled mean becomes a removable Line with Mean selected. V3 saves all layer options, including empty layer lists. At most one Scatter is supported; multiple Lines remain valid for legacy migration. Unsupported duplicate Scatter documents are rejected rather than partially rendered.

For V3 raw Scatter above 50,000 rows, every finite source observation contributes to the occupancy index. Jitter uses a deterministic complete-source derived index, built once with external merge sorting and reused by camera/radius changes. The original source is retained. Jitter construction checks disk/scratch budgets before scanning; when unavailable, a visible diagnostic accompanies the complete original Scatter. Summary layers use all retained source observations, including external aggregation for large sources; they do not use representative samples. New ordinary Line and Time Series layers now use [statistical Line pixel rendering](pixel-statistical-line-rendering.md), including Summary=None. Legacy source-run compatibility layers retain their prior bounded path.

Layer configuration changes reacquire the full domain before validating camera restoration. A prior camera that no longer overlaps the new domain resets to the full view. Independent axis ranges retain finite-value, excessive-zoom and distance checks. Fill renders beneath Scatter, and an explicit radius is not multiplied twice at high DPI.

### Current validation

- Graph backend after the statistical Line pixel integration: 254 passed; explicit performance guards run separately.
- Project archive: 117 passed; frontend service, V3 migration/store and full-option project round-trip checks passed.
- Browser regression: 123 passed in the final full run; the remaining test had a numeric-label formatting expectation corrected, then all four layer scenarios passed on rerun (124 distinct passing scenarios). Four legacy Graph Builder splitter scenarios also passed. Independent review findings were fixed and verified.
- Native GPU regression verifies an isolated outlier from over 2.1 million source observations and radius-cache reuse through the V3 Scatter path; GPU readback also checks that fill cannot cover Scatter.
- A 3,000,000-point, 720×720 debug run with default Stacked jitter measured 21,338 ms cold preparation. Warm radius-1 frames were about 29–33 ms and radius-5 frames about 272–338 ms, including CPU service/raster and synthetic frame allocation. These exclude GPU, IPC and UI; the cold jitter sort is additional work, not a sub-second guarantee.
- Warm radius edits inspect zero source points; all warm/camera requests issue zero source projection queries. Each full-view frame counts all 3,000,000 finite observations.

The historical layout-only desktop checks above refer to the preceding bundle. The Scatter/Line desktop bundle and current validation logs are recorded separately under the ignored experiment artifacts.
