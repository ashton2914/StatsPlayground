# Distribution Fit Inference 与诊断移除验收记录

**日期：** 2026-08-31
**开发状态：** implemented
**自动验收：** passing
**产品 UI 验收：** pending
**参数推断 JMP 19 兼容：** `compatibilityPending`

## 批准范围

本阶段彻底移除 Letter-Value Quantile Plot 与 Stem-and-Leaf，并为 Normal、Lognormal、Exponential、Gamma、Weibull 的自由参数增加固定 95% Standard Error 与 Wald Confidence Limits。

未新增 Cauchy、Student's t、GOF、模型 Q-Q/P-P/CDF、bootstrap 或 profile-likelihood interval，且未改变现有 point estimates、AIC/AICc/BIC、Fit All 排序或 PDF coordinates。

## 已移除能力

以下表面均已删除：

- Rust kernel 计算与私有类型。
- Rust IPC models、chart-data variant 与 report block payload。
- service report assembly。
- TypeScript chart union、graphCore adapter。
- React Stem component、Y-level menu、visibility/preferences。
- 四语言专属文案、component/chart tests 与 visual compatibility fixture cases。

旧项目中的 `quantileBoxPlot` 和 `stemAndLeaf` 偏好字段由 Distribution store 在加载与提交配置时删除；旧项目仍可打开，后续保存不再产生这些字段。

## 参数合同

每个公开自由参数输出：

- `estimate`
- `standardError`
- `lowerConfidence`
- `upperConfidence`

参数表固定显示 `Parameter | Estimate | Std Error | Lower 95% | Upper 95%`。

参数行：

| Distribution | 参数行 |
| --- | --- |
| Normal | Location、Dispersion |
| Lognormal | Scale、Shape；保留 natural-log 说明 |
| Exponential | Scale |
| Gamma | Shape、Scale |
| Weibull | Shape、Scale |

Exponential、Gamma、Weibull 的固定 Location 0 不进入 `FitEstimateV1` 公开参数数组或 UI；`estimatedParameterCount` 与最终参数数组长度一致。

## 统计方法

- Normal/Lognormal：MLE 解析信息，$SE(\mu)=\sigma/\sqrt W$，$SE(\sigma)=\sigma/\sqrt{2W}$。
- Exponential scale：$SE(\theta)=\theta/\sqrt W$。
- Gamma：shape/scale observed information；本地 trigamma 递推与渐近级数由 $\psi_1(1)=\pi^2/6$、$\psi_1(1/2)=\pi^2/2$ 验证。
- Weibull：log(shape)/log(scale) 中心差分 Hessian，$10^{-8}$ transformed-center 规范化及 delta method。
- 95% Wald limits 使用 $z_{0.975}=1.959963984540054$。
- singular/non-finite information 保留 Estimate，并以 `distribution.fit.parameterInformationSingular.v1` 返回 typed unavailable SE/limits。

五模型 unique public fixture 已钉死 Estimate、SE、Lower 95%、Upper 95% 字面值；Frequency compact/expanded、Weight、determinism 和 service payload symmetry 均有回归测试。

## TDD 与复核

- 后端删除测试先观察到原结果仍含 `quantileBox`/`stemAndLeaf`，删除后 report 只保留批准 block。
- UI 五列表先以缺少 `Std Error` 失败，合同和渲染接入后通过。
- Weibull Frequency 等价测试发现二阶差分放大微小 optimizer 中心差异，随后增加 transformed-center 规范化并冻结数值推断容差。
- 中期审查发现 Exponential owning fit 仍含 Location、五模型字面推断 fixture 缺失、reason 未本地化；全部修复后最终实现复核 Approved。

## 最终自动门禁

| Gate | 结果 | 准确计数 |
| --- | --- | ---: |
| `npm run test:distribution` | passing | 51 Playwright CT；0 failed；全部 Distribution assertion scripts 通过 |
| `npm run build` | passing | 983 modules transformed |
| `cargo test --lib` | passing | 254 passed；0 failed |
| `cargo clippy --lib --tests` | passing with repository warnings | exit 0 |
| 四语言 JSON parse | passing | 4 / 4 |
| `git diff --check` | passing | 0 whitespace errors；仅 Windows LF/CRLF 提示 |

首次后端全量尝试遇到 Windows `LNK1104`，原因是旧 target 中 test executable 被残留 runner 占用；使用独立 `target-fit-inference-final` 后完整 254 项测试通过。该环境问题不属于产品代码失败。

## 产品 UI 验收边界

Playwright CT 覆盖五列表、模型参数名称、固定 Location 缺席、localized typed unavailable、菜单移除、report layout 和相关图表。该证据不等同于真实 Tauri 数据导入后的人工产品验收，因此 `uiAcceptance` 保持 `pending`。

Tauri smoke 复用现有开发实例：`localhost:1420` 返回 HTTP 200；`stats-playground` PID 47040、窗口标题 `StatsPlayground`、`Responding=True`。
