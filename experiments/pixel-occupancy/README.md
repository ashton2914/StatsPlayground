# Pixel occupancy lab — Issue 281

Independent feasibility experiment. Production Graph Builder, Tauri and DuckDB are untouched.
All source points participate in the reference occupancy calculation; centers sharing a physical pixel may merge.
One color, opaque points, linear axes, uniform pixel radius. Output dimensions are physical pixels (apply DPR before invoking).

## Build and quick validation

Run in this directory:

```sh
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo build --locked --release
python3 run_matrix.py --out artifacts/smoke
```

Open `artifacts/smoke/report.md` and its PNG images. Every indexed view is checked against a full scan; a mismatch fails the run.
Tests cover boundary points, duplicates, isolated points, nonfinite coordinates, holes, zoom/pan, block collapse,
and real files across resident/mmap/stream modes, including refusal to overwrite and rejection of incomplete indexes.

## Requested stress matrix

```sh
python3 run_matrix.py --stress --out artifacts/stress
```

This actually generates 100 million, 1 billion and 5 billion point datasets, plus 100 million point
cluster, filament and shuffled controls. About **51.2 GB of dataset files** are retained; require an extra 20 GiB disk reserve.
No raw datasets or build outputs belong in Git. The script refuses an existing output directory. Run sequentially to avoid competing benchmarks.

| Points | XY f32 bytes | Stress modes | Repetitions |
|---:|---:|---|---:|
| 100,000,000 | 800,000,000 | mmap, resident, stream | 3 |
| 1,000,000,000 | 8,000,000,000 | mmap, resident | 1 |
| 5,000,000,000 | 40,000,000,000 | mmap | 1 |

The 5-billion-point file exceeds this session's 36 GiB physical memory: that row measures file-backed/paging behavior,
not RAM-resident performance. Resident mode allocates a heap copy, with an 8 GiB default budget and 16 GiB maximum;
pages are not pinned. Mmap establishes virtual addresses and does not prove physical residency.
Single samples at the largest sizes deliberately establish feasibility, not P95 or a statistically qualified performance limit.

## Individual runs

```sh
target/release/pixel-occupancy-lab generate --data artifacts/custom.bin --points 100000000 --profile clusters --layout tiled --seed 281
target/release/pixel-occupancy-lab run --data artifacts/custom.bin --out artifacts/custom-run --storage mmap --width 720 --height 720 --threads 4 --repeats 3 --radius 3
target/release/pixel-occupancy-lab run --data artifacts/custom.bin --out artifacts/custom-zoom --storage mmap --view 0.12,0.15,0.12,0.15 --radius 5
```

Use `--profile uniform|clusters|filament`, `--layout tiled|shuffled`, `--storage mmap|resident|stream`.
Generate uses bounded 65,536-point buffers. Counts, record offsets and file sizes support more than 32-bit point counts.
Each run emits `measurements.jsonl` after each completed view and final `report.json`; partial runs have no final report.
Generated datasets and metadata must remain immutable while mapped. Length, index coverage and modification time are
checked; this is an internal generated-data format, not a cryptographically authenticated general file importer.
Little-endian 64-bit hosts only. Do not change or truncate a mapped dataset externally.

## What is measured

1. Generation and file synchronization, separate from a subsequent index-building pass.
2. Storage setup: mmap construction or heap loading.
3. Full coordinate read plus integer checksum (a useful baseline, **not a pure hardware bandwidth benchmark**).
4. Full sequential occupancy, plus thread-local masks/OR reduction for the full view.
5. Indexed occupancy: inspect every block bounding box, skip invisible blocks, collapse blocks wholly inside one pixel,
   scan remaining coordinates. Report logical coordinate bytes requested and source points read/collapsed.
6. Exact squared Euclidean distance transform on the discrete center grid, thresholded by radius. This is O(pixel count)
   and matches grid-center circles; it does not claim subpixel equivalence or alpha blending semantics.
7. PPM image export. PNG conversion/report construction are later presentation steps, outside kernel timing.

The index is a **flat block directory**, not a full quadtree. Its per-query metadata work remains proportional to block count.
Tiled datasets arrive spatially ordered by construction. Their favorable query timing excludes a general external sort;
sorting arbitrary imported data is a separate, unimplemented preprocessing cost. Shuffled controls expose this dependence.
All coordinates are generated individually from deterministic 64-bit IDs; the experiment does not repeat a small point buffer.
Synthetic f32 data does not establish correctness for arbitrary high-magnitude f64 source coordinates.

Default views are full, zoom, pan and overscan. Overscan covers twice the span with twice the pixel dimensions on both axes,
preserving scale and using four times the pixels. These are independent query probes; no interactive tile-reuse cache is implemented.
Only in-viewport centers participate. The full image uses a fixed [0,1] domain; radius clips at the boundary. A production
renderer must also query offscreen centers within a radius margin. No GPU, native UI, IPC, picking, category blending or production integration is claimed.

## Evidence and interpretation

`manifest.json` records release-binary/source hashes, commands, exit codes and process wall times.
Per-stage timings include their local mask/scratch allocation. Logical coordinate bytes are **not** actual disk I/O bytes.
OS cache is uncontrolled: generation/index building and read/checksum affect cache state, and the sequential oracle precedes
each indexed query. First invocation must not be labelled cold; use a dedicated cache-controlled campaign for that question.
The full sequential scan is the correctness oracle; small tests also assert independently specified expected pixels.
This measures CPU kernels and file access, not end-to-end UI frame latency or faster-than-existing-renderer speedup.

References: [Datashader pipeline](https://datashader.org/getting_started/Pipeline.html),
[Felzenszwalb–Huttenlocher distance transform](https://cs.brown.edu/people/pfelzens/papers/dt-final.pdf).

Generated/disposable paths: `target/` only. `artifacts/` contains retained datasets, measurements and visual evidence;
it is ignored but is **not disposable without explicit user approval**.
