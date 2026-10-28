# Native UI probe smoke 01

Debug build, 300,000 × 20 fixture, requested two samples per operation. This is
an unqualified collector check and stopped after the first scroll sample.
Catalog and first-window samples had actual native spans and exact visible UI
verification. The first scroll target (row index 50) was already in the initial
500-row cache, so it produced no matching native query. The collector retained
that sample with nativeCalls=0, backendMs/transferredBytes=null and failed logical
verification. It preserved empty edit/close reports as failed, not successful.

Next probe uses distant rows outside the initial window/prefetch. No missing
observation is replaced with zero. These reports are immutable and remain failed.
