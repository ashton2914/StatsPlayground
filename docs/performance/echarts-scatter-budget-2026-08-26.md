# ECharts Scatter Budget - 2026-08-26

This benchmark ran ordinary ECharts canvas scatter series inside the Tauri WebView. Each candidate was measured three times in ungrouped, two-group, and four-facet layouts. The policy uses the median coherent-frame time and maximum longest-task time across all nine runs per candidate.

## Environment

| Item | Value |
| --- | --- |
| OS | win32 10.0.26200 (x64) |
| CPU | Intel(R) Core(TM) i7-10850H CPU @ 2.70GHz (12 logical processors) |
| WebView2 | 151.0.0.0 |
| User agent | Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0 |
| App version | 0.1.0 |
| App build | b7b3f83 |
| ECharts | file:vendor/echarts-5.6.0.tgz |

## Measurements

| Points | Median setOption (ms) | Median coherent frame (ms) | Maximum longest task (ms) | Median zoom patch (ms) | Median brush (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5,000 | 57.2 | 60.0 | 145.0 | 31.1 | 32.0 |
| 8,000 | 84.6 | 88.2 | 98.0 | 37.3 | 25.6 |
| 10,000 | 105.0 | 109.9 | 124.0 | 49.8 | 28.6 |
| 20,000 | 220.4 | 228.1 | 327.0 | 151.2 | 81.0 |
| 50,000 | 539.1 | 565.0 | 1090.0 | 675.9 | 301.6 |
| 100,000 | 1296.2 | 1375.5 | 3607.0 | 1943.4 | 961.4 |

## Selected Budget

The largest measured candidate meeting coherent frame <= 2,000 ms and longest task <= 200 ms was 10,000 points. Its 20% safety reduction, rounded down to the nearest 1,000, produced the 8,000-point cap. The final budget is the largest measured passing candidate at or below that cap: 8,000 points. No unmeasured value is selected.

`SCATTER_RENDER_BUDGET = 8000`
