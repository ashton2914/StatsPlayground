# Historical StatsPlayground work

These files record designs and experiments from retired branches. The patches are historical diffs with zero context. Review them against the recorded base before using any part in a new branch.

| Issue | Archive | Context |
| --- | --- | --- |
| #218 | [Time Series design and plan](218-time-series/) | From `a388f108`. Time Series shipped separately in PR #225. |
| #245 | [Shared layer menu patch](245-layer-menu/layer-menu.patch) | Commit `2805e2a8` against its parent. Current Graph Builder-new uses the later layer model. |
| #261 | [Graph layer design and plan](261-graph-layers/) | From `7808135d`. Records the layer-control work alongside the later rendering implementation. |
| #263 | [Direct DataLink SQL prototype](263-datalink-sql/) | Prototype, test, extension packaging scripts, and integration diff from base `445046c8`. PR #293 shipped saved/filtered imports separately. Restore local fixture credentials before running the historical probes. |
| #275 | [Repeated-arrow test](275-keyboard-navigation/repeated-arrows-test.patch) | From base `4f6b6825`. The synthetic test checks active-cell navigation and does not reproduce the original Windows white screen. |
