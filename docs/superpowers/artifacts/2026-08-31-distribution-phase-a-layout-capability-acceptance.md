# Distribution Optimization Handbook Phase A 验收记录

**日期：** 2026-08-31
**开发状态：** implemented
**自动验收：** passing
**产品 UI 验收：** pending
**JMP 19 exact interval 兼容：** `compatibilityPending`

## 批准范围

本记录仅覆盖 approved Phase A：横向 Count Overview、独立 Fit Density、统一 report bounds、Moving Range effective-DF Within interval、参数化 confidence headings，以及 Tasks 3-5 parked Low contracts。

Phase B-E 的 Custom Quantiles、Summary 定制、推断检验、Continuous Fit Stage 2/3 与高级分布不在本次实现范围。

## 自动验收矩阵

| 能力 | developmentStatus | automationStatus | uiAcceptance | 证据 |
| --- | --- | --- | --- | --- |
| Overview 横向 Count + 右侧 Box | implemented | passing | pending | `[count, lower, upper]`、box/outlier axis indices、plot rect 与 canvas 非空测试 |
| 独立 Fit Density | implemented | passing | pending | density/PDF series 分离、failed/empty suppression、颜色跨顺序/子集稳定 |
| 统一 report bounds | implemented | passing | pending | 3 viewport CT：外缘 `<=2px`、paired top `<=3px`、无横向 overflow |
| Within effective-DF intervals | implemented | passing | pending | n=51 fixture、effective DF、Within/Overall 回归与 finite typed fields |
| Confidence/IPC contract | implemented | passing | pending | 95%/90% headings、旧 CI headings 缺席、Rust camelCase serde |

## TDD 证据

三 viewport CT 先于 CSS 修改写入。首次运行结果：`1440x900` 与 `1024x700` 通过，`768x900` 因 Capability 第二列仍在同一行而失败，received Y `708` 未大于第一列底部 `741`。

最小 CSS 修复统一 surface sizing，移除 Quantiles 固定宽度，将 Fit/Capability 双栏 gap 统一为 18px，并把单栏断点统一为 900px。相同 focused command 随后为 `3 passed, 0 failed`。

Tasks 3-5 parked Low tests 共 6 项，均已进入永久 gate。

## 最终自动门禁

| Gate | 结果 | 准确计数 |
| --- | --- | ---: |
| `npm run test:distribution` | passing | 49 Playwright CT；0 failed；typecheck 与 11 个 assertion scripts/contract entrypoints 全部通过 |
| `npm run build` | passing | 984 modules transformed |
| `cargo test --lib` | passing | 246 passed；0 failed |
| 四语言 JSON parse | passing | 4 / 4 |
| `git diff --check` | passing | exit code 0；0 whitespace errors |
| touched-file diagnostics | passing | 0 errors |

## Strict Clippy 基线

`cargo clippy --lib -- -D warnings` 已执行并按既有仓库基线失败：45 diagnostics。

| lint family | 数量 |
| --- | ---: |
| `dead_code` | 22 |
| `too_many_arguments` | 11 |
| `type_complexity` | 3 |
| `enum_variant_names` | 2 |
| `needless_range_loop` | 2 |
| `derivable_impls` | 2 |
| `collapsible_if` | 1 |
| `manual_div_ceil` | 1 |
| `manual_pattern_char_comparison` | 1 |

本阶段未添加 blanket allow，也未扩大范围清理无关 lint。

## Tauri smoke 与截图

- `stats-playground` PID 63248：`Responding=True`，窗口标题 `StatsPlayground`。
- `http://localhost:1420`：HTTP 200。
- 通过 Win32 `PrintWindow` 捕获 `1200x800` 非空 desktop render：`2026-08-31-distribution-phase-a-layout-capability-tauri-smoke.png`。
- 截图只显示应用 shell 与空 Directory，证明进程和 desktop render 可用；它没有覆盖 51-row missing-region Distribution 场景。

因此自动 smoke 和截图不得提升为正式 UI passed。

## 待正式 UI 验收

1. 在 51-row missing-region group 验证 Overview 横向 Count、右侧 Box 与共享 `sales_amount` Y axis。
2. 验证 LSL/Target/USL label 与 scrollbar 不重叠。
3. 验证 Fit Density 独立于 Overview 且 PDF 与 Density scale 对齐。
4. 在 wide/narrow desktop window 验证 Overview、tables、Capability、Fit reports 外边界。
5. 验证 `Lower 95% / Upper 95%` 与 effective-DF Within interval；确认 Overall interval 未改变。

## 兼容性结论

Phase A 实现采用公开 Moving Range effective-DF 近似。n=51 fixture 的公开结果与 JMP 19 rounded observation 分开保存；未调常数拟合截图。非中心 t、Cpk 专用 exact interval 及更广脱敏 fixture 未完成前，exact interval compatibility 保持 `compatibilityPending`。
