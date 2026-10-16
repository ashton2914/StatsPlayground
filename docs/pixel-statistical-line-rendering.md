# Statistical Line pixel rendering

Line computes statistics at each original X/group before rasterization. Screen bins never average those results again. Three distinct X values projected into one pixel column can therefore light an entire vertical interval when their connected Y values cross that interval.

## Data and rendering

- New Line and Time Series layers retain all source observations. Ordered unique retained X values stream directly as one-observation summaries. Mean/Sum with at most 65,536 groups use bounded accumulators; higher cardinality and exact grouped medians use external sorting.
- Statistical results are stored in a temporary, immutable mmap at 48 bytes/result. Row order uses each group's first source scan ordinal; its reorder is externally sorted with bounded chunks.
- A hierarchy indexes connected ranges and their bounds. A continuous, single-group, interval-free straight line entirely inside one pixel column can mark its vertical extent directly. Missing values and group changes prevent that shortcut.
- Other ranges traverse their original connections and mark crossed pixels. Endpoints outside the viewport still contribute crossing lines. Step and Spline retain the existing connection definitions; Spline bounds include its actual interpolated extrema.
- Error bars, bands and fills use the statistical results. View-edge error caps are included in queries. Fill clips in data coordinates before projection, and long fill scans check cancellation every 32 rows.
- The renderer combines fill, raw Scatter and Line into frame-sized textures. Source-over blending preserves the underlying grid and opaque frame alpha. Summary Scatter markers render above that texture.
- Statistics/indexes survive camera changes; the pixel mask cache depends on camera, physical frame/plot, DPI and enabled groups. Radius-only Scatter changes reuse Line masks. Normal Line layers upload no per-result line geometry.

V1/V2 documents still migrate their raw source-run compatibility layers. Those compatibility layers retain the prior bounded geometry path; newly added ordinary Line/Time Series layers use the pixel pipeline, including Summary=None.

## Resource boundaries

The graph runtime retains its existing 1 GiB reservation budget, including 256 MiB for GPU resources, and 64 GiB disk budget. Dataset storage, other application features and OS file-page caching are outside this graph allocation budget. Statistics, sorting scratch files, Line results and derived Scatter jitter share those budgets. A source-policy transition can evict the previous source index while the frontend retains its coherent bitmap. Construction reservations transfer into cache reservations without charging the same completed build twice.

Pixel output is bounded by frame resolution; cold data preparation still depends on source size and ordering. Row-order curves and other irregular paths can require scanning many candidate connections. These are not constant-time or sub-second guarantees. Billion-point Line preparation has not been measured by this change.

## Verification

Graph regression: 254 passed, with two explicit performance guards excluded from the ordinary suite. Archive regression: 117 passed. Tests cover original-X aggregation before screen projection, same-column spikes, indexed-vs-every-segment coverage across zoom, crossing endpoints, missing/group breaks, row-order merge boundaries, Step/fill, Spline overshoot, view-edge caps, extreme finite fill coordinates, cancellation and shared disk admission. The 2,032,293-row source-policy regression also checks real GPU output and warm radius reuse without per-segment geometry.

A separate 3,000,000-result, 720×720 debug CPU service measurement produced:

| Phase | Time |
| --- | ---: |
| Cold preparation and first mask | 32,947 ms |
| Cached full view, four samples | 53–62 ms |
| Zoom/pan, five samples | 198–203 ms |
| Hierarchy allocation | 234,560 bytes |

Timings include source/statistics/index preparation, masks/composition and a synthetic frame. They exclude GPU rendering, IPC, image decoding and UI presentation. Warm requests issue zero source projection queries; cached full-view requests inspect zero raw source points.

The final desktop bundle was exercised with an actual 2,032,293-row, 52-column project: category X, Uniform Scatter jitter, independent Mean Line, zoom-out/pan and Reset. Both layers rendered with zero excluded rows and no budget error. The existing project was saved and copied before restart. A ready 3,000,000-row Scatter+Line project and build/source hashes accompany the ignored desktop artifacts.
