# Distribution Continuous Fit Stage 1 验收记录

**日期：** 2026-08-30
**自动验收：** passing
**产品 UI 验收：** pending
**数值兼容目标：** JMP 19（当前全流程状态为 `compatibilityPending`）

> **后续覆盖：** 本记录保留 Stage 1 当时的验收事实。当前参数合同、固定 Location 显示与诊断能力状态以 [Fit Inference 与诊断移除验收记录](2026-08-31-distribution-fit-inference-and-diagnostics-removal-acceptance.md) 为准。

## 已交付范围

| 能力 | developmentStatus | automationStatus | uiAcceptance | 兼容状态 |
| --- | --- | --- | --- | --- |
| Normal MLE | implemented | passing | pending | `compatibilityPending` |
| Lognormal MLE | implemented | passing | pending | `compatibilityPending` |
| Exponential location0 MLE | implemented | passing | pending | `compatibilityPending` |
| Gamma shape/scale MLE | implemented | passing | pending | `compatibilityPending` |
| Weibull shape/scale MLE | implemented | passing | pending | `compatibilityPending` |
| Fit All + AIC/AICc/BIC | implemented | passing | pending | `compatibilityPending` |
| PDF overlay | implemented | passing | pending | backend-owned coordinates |
| 参数/指标/比较报告 | implemented | passing | pending | typed payload |

Stage 2 的 GOF、Cauchy、Student's t 与模型诊断，以及 Stage 3 的 SHASH、Johnson、mixtures、Smooth Curve尚未实现。

## 数值与合同证据

- 闭式 Normal、Lognormal、Exponential MLE覆盖参数、加权、Frequency展开、domain与常量样本。
- Gamma/Weibull使用固定版本argmin 0.11.0；profile score root精化、共享500次预算、log-domain Weibull与极端scale equivariance有独立测试。
- Kish effective N、AIC/AICc/BIC、AICc不可用状态和派生指标溢出隔离有测试。
- Fit All按可用AICc、AIC fallback、tolerance tie ID、失败后置稳定排序。
- 单模型domain/optimizer/objective/curve失败不阻塞其他模型，不生成伪曲线。
- 所有available序列化数值finite；不输出NaN/Infinity。
- Rust/TS fit、comparison、optional presentation preference合同镜像并进入永久typecheck门禁。

## UI与运行证据

- bootstrap capability registry只暴露五个Stage 1 fit IDs；菜单与backend capabilities取交集。
- explicit model与Fit All互斥；未实现的Stage 2/3模型不显示。
- active run在提交新revision前取消；runtime test验证backend cancel、store cancel、commit、updated-item rerun顺序及cancel失败不commit。
- 新run启动时实时读取Zustand run state，避免旧React closure对同一cancel token二次取消。
- available、failed/unavailable与comparison报告使用typed payload；comparison不在前端重排。
- PDF curves由Rust提供，前端直接映射`[x,y]`，稳定颜色/顺序并参与axis extent。
- overlay/details为presentation-only；legacy缺省为显示，不触发重新计算。
- convergence/status及已知reason类别支持四语言；未知reason保留machine code。
- 参数、统计量和comparison表具有完整网格。
- 每个fit block的可见标题包含分布名称，例如`Continuous Fit - Normal`。
- Gamma/Weibull在$x=0$按shape正确处理；shape小于1的奇异密度使用严格正侧有限curve sample，不伪造零密度或序列化Infinity。

## 最终门禁

- `cargo test --lib`：242 passed，0 failed（包含最终PDF边界修复）。
- `npm run test:distribution`：42 Playwright CT passed；contracts/typecheck/adapter/report/golden/blackbox均passing。
- `npm run build`：passing，984 modules transformed。
- 四语言JSON parse：passing。
- `git diff --check`：passing。
- Tauri smoke：`stats-playground.exe` responding；`http://localhost:1420`返回200且root存在。
- `cargo clippy --lib -- -D warnings`：被仓库既有`too_many_arguments`、`needless_range_loop`和dead-code基线阻塞；未添加blanket allow。

## 人工 UI 待验收

1. 在真实正偏数据上依次选择Normal、Gamma、Fit All，确认旧报告在updating期间保持可见。
2. 确认Fit All产生五个模型结果，排序稳定，mixed-sign数据的正域模型显示明确domain failure。
3. 检查五条PDF曲线与`Probability Density` Histogram共享X/Y轴，legend在desktop和窄窗口均不侵入plot。
4. 保存并重开项目，确认模型选择和overlay/details偏好恢复，结果按配置重新计算。
5. 在拟合运行中切换模型，确认旧run取消且新revision结果被接受。
6. 检查light/dark主题中的五模型颜色区分、菜单滚动和完整表格线。

自动门禁和进程smoke不得将上述`uiAcceptance`提升为`passed`。
