# Distribution JMP Alignment Stage 1 验收记录

**日期：** 2026-08-31
**开发状态：** implemented
**自动验收：** passing
**产品 UI 验收：** pending
**JMP 数值兼容：** 按能力分别保留 `compatibilityPending` / `intentionalDifference`

## 批准范围

本记录覆盖 JMP 术语与方法对齐 Stage 1：Summary 术语与众数语义、Stability Index、Capability 显示格式、百分比 Nonconformance、Exponential 自由参数计数、Continuous Fit Measures/参数术语、Letter-Value 可见名称，以及可解释且 sign-safe 的 Stem-and-Leaf。

Stage 2 的 Continuous Fit 参数 Standard Error/Confidence Interval、JMP-target 五模型 fixture，以及 Stage 3 的 JMP-target Quantile Box、Stem-and-Leaf 和 exact Capability interval 不在本次实现范围。

## 自动验收矩阵

| 能力 | developmentStatus | automationStatus | uiAcceptance | 证据 |
| --- | --- | --- | --- | --- |
| Summary | implemented | passing | pending | `Std Error Mean`；唯一众数显示数值，ties/all-unique 显示 `No unique mode`；四语言 |
| Capability | implemented | passing | pending | Stability = Overall/Within；indices/intervals 固定 3 位小数；Nonconformance 四列百分比直接读取 proportion |
| Exponential 信息准则 | implemented | passing | pending | registry 拥有自由参数数，payload 返回 `estimatedParameterCount`；Exponential $k=1$，其他 Stage 1 模型 $k=2$；kernel 与 service payload 双层 fixture |
| Continuous Fit 报告 | superseded | passing | pending | 后续 Fit Inference 设计移除 `fixed` 输出，改为自由参数 Estimate/Std Error/Lower 95%/Upper 95% |
| Letter-Value Quantile Plot | removed | passing | notApplicable | 后续产品决策已彻底移除 runtime、contract 与 UI |
| Stem-and-Leaf | removed | passing | notApplicable | 后续产品决策已彻底移除 runtime、contract 与 UI |

本表记录 Stage 1 当时的验收结果；状态冲突时，以 [Fit Inference 与诊断移除验收记录](2026-08-31-distribution-fit-inference-and-diagnostics-removal-acceptance.md) 为准。

## 51 行回归值

固定 fixture：`tests/fixtures/distribution/process-capability-moving-range-v1.json`。

Exponential location 0 模型使用一个自由参数，自动测试冻结：

- $-2\ell = 740.6183972$
- $AICc = 742.7000298$
- $BIC = 744.5502228$

Capability Stability Index 继续由相同 51 行 fixture 验证 Overall Sigma / Within Sigma；Moving Range effective-DF interval 仍是公开方法，未声明 JMP exact compatibility。

## TDD 与独立复核

- Task 1：Summary mode uniqueness 与 `Std Error Mean`，独立复核通过。
- Task 2：Stability、3 位小数与百分比 Nonconformance；review 后统一 method ID、拒绝非正 Within Sigma，并用故意不一致 PPM 证明 UI 读取 proportion。
- Task 3：先以缺少 `estimatedParameterCount` 的编译失败建立 RED，再由 registry 拥有 $k$；独立复核后补 service 级 51 行回归。
- Task 4：旧 Fit Statistics/参数命名使 CT RED；实现 Measures 与模型术语后，修复本地化 accessible name、固定 location 稳健性及 unavailable `-2LL` 覆盖。
- Task 5：先复现 $(-scale,0)$ 符号丢失，再加入 signed-zero bucket；独立复核发现极端有限值 stem 饱和，补 typed unavailable 后复核通过。
- 最终复核：发现 fixed/free 语义仍由 React 推断及批准台账 `CAP-15` 冲突；已将 `fixed`/`estimatedParameterCount` 加入 Rust/TS contract，由 service 统一生成固定 location，并将 `CAP-15` 更新为 implemented。

## 最终自动门禁

| Gate | 结果 | 准确计数 |
| --- | --- | ---: |
| `npm run test:distribution` | passing | 52 Playwright CT；0 failed；typecheck 与全部 Distribution assertion scripts 通过 |
| `npm run build` | passing | 984 modules transformed |
| `cargo test --lib` | passing | 258 passed；0 failed |
| `cargo clippy --lib --tests` | passing with warnings | exit 0；既有 lint 基线仍存在 |
| 四语言 JSON parse | passing | 4 / 4 |
| `git diff --check` | passing | 0 whitespace errors；仅 LF/CRLF 工作树提示 |

## Strict Clippy 基线

`cargo clippy --lib --tests -- -D warnings` 已执行并因仓库既有 warning 基线失败。主要类别包括 `dead_code`、`too_many_arguments`、`items_after_test_module`、`type_complexity`、`enum_variant_names`、`needless_range_loop`、`derivable_impls` 与 `manual_div_ceil`。本阶段未加入 blanket allow，也未扩大范围清理无关 lint；普通 Clippy exit 0。

## 产品 UI 验收边界

组件级 Playwright 已覆盖菜单、报告层级、Summary、Capability、Nonconformance、Continuous Fit、Letter-Value、Stem、Fit Density 与三种 viewport。该证据不等同于真实 Tauri 数据导入后的产品验收，因此 `uiAcceptance` 保持 `pending`。

Tauri smoke：新实例因端口 `1420` 已占用而未重复启动；现有 `localhost:1420` 返回 HTTP 200，Node PID 12952 `Responding=True`；现有 `stats-playground` PID 77200、窗口标题 `StatsPlayground`、`Responding=True`。未终止或替换用户已有进程。

正式 UI 验收仍需在 Tauri 中加载 51 行 missing-region 数据，核对四语言可见术语、Stability/百分比表、Exponential Measures、固定参数行、Letter-Value 名称和 Stem interpretation key。

## 兼容性结论

Stage 1 对齐可观察术语、明确公式和已确认 bug，不把相同名称解释为未证实的 JMP 数值兼容。参数 SE/CI、JMP-target Quantile Box/Stem 和 exact Capability intervals 继续由 Stage 2/3 的新 versioned contracts 承担。
