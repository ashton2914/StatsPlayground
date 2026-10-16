# Massive scatter pixel integration

Issue: https://github.com/ashton2914/StatsPlayground/issues/281

## Design

Replace the sampled massive scatter path with a complete f64 point source, spatially partitioned in bounded batches.
Keep exact small-data line/mean behavior. Massive scatter and points+line requests use a distinct cache key;
pure lines retain the existing path. Retain generation/cancellation fences, typed X transformations, overlay identities,
resource admission and binary frame transport. No sampled point array may feed the massive scatter raster.

The source uses immutable anonymous temporary files and read-only mmap, with 65,536-point construction batches and
1,024-point spatial leaves. Each record contains f64 X/Y and a group code. A view creates a physical-pixel bitmask of
all groups, with an 8-pixel border for marker footprints. Hidden groups are filtered after aggregation; a deterministic
highest-code group wins an opaque overlap. Cache one view's centers, so radius/group visibility edits reuse the scan.
Circular marker expansion produces an RGBA texture, composited after grid decorations and before lines/mean on the GPU.
No per-source-point GPU geometry is generated. Texture and scratch allocations are bounded by validated frame dimensions.
Completion metadata explicitly sets `pixelAggregated`: occupied pixel counts are bounded by the plot area and are
independent of visible source row counts. Legacy geometry-count validation remains unchanged.

Massive sources are cached in-process only for this test version. They are never serialized into the old pyramid format.
The construction budget accounts for original spool plus complete source; disk budget is expanded to 64 GiB, while
existing CPU/GPU reservations remain. Exhausting budget fails explicitly, without silently sampling.

## Implementation plan

1. Add failing occupancy tests: independent pixel oracle, outliers, nonfinite values, boundaries, overlay reveal,
   offscreen marker margin, zoom, cancellation, source scan reuse and resource limits.
2. Implement full-source storage, bounded spatial indexing, cached pixel aggregation and circular expansion.
3. Connect production builder/cache/service, retaining small exact mode; isolate keys and cache persistence.
4. Add GPU texture composition and an adjustable physical-pixel radius control; test real frame transport.
5. Run Rust graph regressions and affected frontend tests/build; independently review actual diff, then launch
   an isolated desktop instance for manual large-data validation. Preserve raw experiment artifacts and do not publish.

## Acceptance

Complete-source occupancy must match an independently calculated mask with no missing or extra pixels. Group hiding
must reveal lower groups at shared pixels. Radius edits must not rescan an unchanged view. Native rendering must show
the isolated point and preserve axis alignment at DPR 1/2. Start the application from this worktree, identifying its
binary, window and URL. Report actual test evidence and remaining manual/performance limitations separately.

## Desktop test version

The isolated application is named `StatsPlayground Pixel Lab 281`, with identifier
`com.statsplayground.pixel-lab`. Its Release bundle is retained under
`experiments/pixel-occupancy/artifacts/desktop-test/`. Import `pixel-test-3-million.csv` from that directory,
open **Graph → Graph Builder for massive data**, and assign X/Y. The single point at (1.25, 1.25)
should remain separate from the dense band. Try zooming, panning, radius 1–8, and overlay Group visibility.
For a ready-configured view, use **File → Open Project** and select `Pixel Lab Ready.spprj` or
`Pixel Lab Grouped.spprj` in the same directory, then click the graph document in the tree.
From this worktree, restart the test application with:

```sh
open "experiments/pixel-occupancy/artifacts/desktop-test/StatsPlayground Pixel Lab 281.app"
```

The pixel path starts above 2,100,000 finite XY pairs; small plots retain their exact path. Radius is measured
in physical pixels and currently expands occupied center pixels. It does not retain subpixel positions for
marker coverage. Pure line mode retains its previous renderer. Radius is local to the open view in this prototype.

Initial database import, complete-source construction, and subsequent viewport queries are separate costs.
The integration retains f64 coordinates and 24-byte mapped source records; earlier standalone f32 benchmark
timings are not desktop performance measurements. Construction can temporarily require approximately 50 bytes
per finite point (spool plus mapped source), before database storage and indexes. The 64-GiB disk admission limit
means this desktop prototype does not support constructing a 5-billion-point source. The standalone stress lab
and its original artifacts remain available for that scale.

## Verification

- Production Rust graph tests: 202 passed, including a 2,100,001-point source with actual GPU frame readback,
  isolated point preservation, DPR 2, and radius edits without source rescanning.
- Frontend TypeScript check and production build passed; service, camera and transport contract tests passed.
- Added browser regression covers radius forwarding and line/scatter cache creation followed by camera restore.
- Native WebView acceptance exposed an old completion validator assumption that exact rendering must submit one mark
  per visible row. Added pixel aggregation metadata and frontend tests for many rows sharing pixels, expanded markers
  occupying more pixels than visible rows, offscreen footprints, malformed flags, and plot-area bounds.
- Native acceptance also exposed JSON coordinate drift during camera navigation. Enable serde_json `float_roundtrip`
  and test raw decimal parsing against correctly rounded f64 values, without loosening the frontend's camera equality
  checks. Reset view now sits outside the plotting surface so it cannot cover an extreme-value isolated point.
- Independent review found two cache-routing defects; both were fixed and the reviewer confirmed their resolution.
- Full Rust library run: 1,563 passed, 18 ignored, one unrelated OLS warning-order test failed because its fixture
  lacks a predictor mean. The same failure was reproduced using an unchanged October 10 test executable.
- An existing Workspace creation browser test still uses the old `Graph Builder-new` menu label and hidden field
  controls; it fails independently of this change. Other Workspace scenarios are checked separately.
- Final Release native acceptance: imported/opened 3,000,000 rows; full view at radius 5 displays 87,822 colored pixels
  with the isolated (1.25, 1.25) point visible at the upper-right boundary. Verified radius changes, hiding/restoring
  groups, zoom, repeated panning after maximum zoom-out, and reset. The live window is left on the full grouped view.
