# Native UI probe smoke 02

Unqualified debug collector run, 300,000 × 20, two requested lifecycle cycles.
Both distant scrolls had matching native queries and exact visible values. The
second formula edit timed out after the cell value persisted but selection did
not advance. Failed sample and partial reports are retained. One first-window
sample includes a 12-second scheduling delay; no outlier is removed or corrected.

A component regression reproduced Enter followed by focus loss during native
acknowledgement/window refresh: a second write advanced dataset generation to 3
instead of 2 and the active cell stayed unchanged. FormulaBar now guards Enter
and blur commits with one synchronous in-flight owner. This report predates that
repair and remains failed. It is neither release nor performance qualification.
