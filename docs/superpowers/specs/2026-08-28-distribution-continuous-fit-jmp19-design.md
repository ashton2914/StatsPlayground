# Distribution Continuous Fit 与 JMP 19 功能覆盖设计

**日期：** 2026-08-28
**状态：** 已批准
**目标：** 接近 JMP 19 Continuous Fit 菜单的功能覆盖，并对数值兼容性保持可审计声明
**依赖：**
- [Distribution 主设计](2026-08-25-analysis-distribution-design.md)
- [Distribution 批准范围与验收台账](2026-08-26-analysis-distribution-approved-scope.md)
- [Distribution 可视化诊断设计](2026-08-27-distribution-visual-diagnostics-jmp19-design.md)

## 1. 目标与原则

Continuous Fit 在同一连续 Y 样本上拟合一个或多个参数分布，显示参数估计、模型比较、拟合优度和诊断图，并将 fitted PDF 叠加到 Probability Density Histogram。

本设计采用以下原则：

1. Rust 拥有样本预处理、MLE、优化、信息准则、拟合优度和所有图形坐标。
2. React 只管理选择、显示偏好和持久化；graphCore 只映射冻结坐标。
3. 只有 capability registry 中真实可执行的方法才显示在菜单中。
4. 每个模型独立成功或失败；Fit All 不因单个模型失败而丢失其他结果。
5. 方法名称相同不代表 JMP 数值兼容；兼容状态必须由公式或脱敏黑盒 fixture 支持。
6. 不复制 JMP 界面、帮助正文、代码或受保护资产。

## 2. 分阶段范围

### 2.1 阶段 1：基础 Fit Registry 与常用分布

交付：

- Normal
- Lognormal
- Exponential（location 固定为 0）
- Gamma
- Weibull
- Fit All（仅包含阶段 1 已注册模型）
- MLE 参数表
- LogLikelihood、AIC、AICc、BIC
- fitted PDF overlay
- typed convergence、domain failure 和 unavailable 状态
- Weight/Freq 语义
- 项目 archive round-trip

阶段 1 建立统一 optimizer abstraction。Normal、Lognormal、Exponential 使用闭式估计；Gamma 和 Weibull 使用同一 deterministic constrained optimizer。优先采用经过许可证审查并固定版本的 Rust optimizer crate，不在各模型中散落自制优化算法。

### 2.2 阶段 2：重尾模型与拟合诊断

交付：

- Cauchy
- Student's t
- Anderson-Darling
- Pearson chi-square（仅在有效分箱条件下）
- 模型特定 Q-Q、CDF 和 P-P 图
- Fit All 失败原因与稳定排序
- 参数标准误和置信区间（可识别且 Hessian 有效时）

Shapiro-Wilk 只用于 Normal fit 的辅助诊断，不作为所有模型的通用排序指标。

### 2.3 阶段 3：高级模型

交付：

- SHASH / sinh-arcsinh
- Johnson family
- Normal 2 Mixture
- Normal 3 Mixture
- Smooth Curve / nonparametric density
- 完整 Fit All registry

Mixture 必须具有 deterministic 多起点策略、固定 seed、组件稳定排序、label-switching 处理、局部最优警告和显式未收敛状态。Johnson 必须先冻结 family 选择规则和参数化。Smooth Curve 必须冻结 kernel、bandwidth、边界修正和 Weight/Freq 规则。

## 3. 方法定义

### 3.1 参数化

阶段 1 使用以下参数化：

| distributionId | 参数 | 支持域 |
| --- | --- | --- |
| `normal` | location $\mu$、scale $\sigma>0$ | 所有 finite 值 |
| `lognormal` | log-location $\mu_{\log}$、log-scale $\sigma_{\log}>0$ | $x>0$ |
| `exponential` | scale $\theta>0$，location 固定为 0 | $x\ge 0$ |
| `gamma` | shape $\alpha>0$、scale $\theta>0$ | $x>0$ |
| `weibull` | shape $k>0$、scale $\lambda>0$ | $x>0$ |

参数化 ID 必须进入 provenance，例如 `gamma.shapeScale.location0.v1`。不得仅返回含义不明确的 `parameter1`、`parameter2`。

### 3.2 加权似然

每条有效 observation 具有 value $x_i$、Frequency $f_i$ 和 Weight $w_i$。

- 无 Frequency 时 $f_i=1$。
- 无 Weight 时 $w_i=1$。
- Frequency 必须为正整数，表示精确复制。
- Weight 必须 finite 且 $>0$。
- 加权 log-likelihood：

$$
\ell(\theta)=\sum_i f_i w_i\log p(x_i\mid\theta)
$$

仅有 Frequency 时：

$$
n=\sum_i f_i
$$

存在 Weight 时，AICc/BIC 使用 Kish effective sample size：

$$
n_{eff}=\frac{(\sum_i f_iw_i)^2}{\sum_i f_iw_i^2}
$$

该 Weight 规则在获得 JMP 黑盒证据前标记 `compatibilityPending`。界面必须显示 method provenance，不得宣称 JMP compatible。

### 3.3 信息准则

令 $k$ 为自由估计参数数量：

$$
AIC=2k-2\ell
$$

$$
AICc=AIC+\frac{2k(k+1)}{n_{eff}-k-1}
$$

$$
BIC=k\log(n_{eff})-2\ell
$$

当 $n_{eff}\le k+1$ 时，AICc 返回 typed `unavailable`，不得返回 Infinity/NaN。

Fit All 排序规则固定为：

1. 可用 AICc 升序。
2. AICc 不可用时，可用 AIC 升序。
3. 指标相同或在容差内时按 `distributionId` 升序。
4. failed/unavailable 模型列在成功模型之后，并显示 reason code。

### 3.4 曲线坐标

后端在当前 histogram/规格/观测值统一 X extent 上生成 256 个有序点。PDF、CDF、Q-Q、P-P 坐标全部由 Rust 返回；前端不得重新计算分布函数或参数。

PDF overlay 与 Probability Density Histogram 使用同一 X/Y axis。曲线积分语义为 1，不按 count 缩放。

## 4. 版本化合同

### 4.1 计算配置

```ts
interface DistributionContinuousFitConfigV1 {
  enabledDistributionIds: ContinuousDistributionIdV1[];
  fitAll: boolean;
  diagnostics: {
    goodnessOfFit: boolean;
    qqPlot: boolean;
    cdfPlot: boolean;
    ppPlot: boolean;
  };
}
```

模型选择属于计算配置：更新 `configRevision` 并启动新 run。选择或移除模型时保留当前 committed report，直到四键 run identity 接受新结果。

`fitAll=true` 表示运行当时 registry 内所有已实现、且适用于当前数据域的模型。结果必须记录实际候选 ID，避免未来 registry 扩展改变历史解释。

### 4.2 Fit payload

```ts
interface DistributionFitDataV1 {
  schemaVersion: "1";
  fitId: string;
  distributionId: ContinuousDistributionIdV1;
  parameterizationId: string;
  status: "available" | "unavailable" | "failed";
  reasonCode: string | null;
  parameters: DistributionFitParameterV1[];
  effectiveN: number;
  logLikelihood: CapabilityTypedValueV1;
  aic: CapabilityTypedValueV1;
  aicc: CapabilityTypedValueV1;
  bic: CapabilityTypedValueV1;
  goodnessOfFit: DistributionFitGoodnessOfFitV1[];
  fittedCurve: DistributionFittedCurveDataV1 | null;
  diagnostics: DistributionFitDiagnosticDataV1[];
  convergence: DistributionFitConvergenceV1;
  provenance: DistributionFitProvenanceV1;
  warnings: string[];
}
```

`DistributionReportBlockV1` 增加可选 `distributionFitData`。本阶段不重写既有 block union，避免扩大迁移面；所有 fit block 必须满足 `kind="continuousFit"` 与 payload 同时存在的 validator。

### 4.3 Provenance

必须记录：

- method ID/version
- parameterization ID
- optimizer ID/version
- initialization strategy ID
- convergence tolerance 与 iteration limit
- dependency versions
- snapshot ID
- config revision
- candidate registry IDs
- compatibility status

任何未收敛、边界解、奇异 Hessian 或退化 mixture 都必须产生 typed warning/reason code。

## 5. 后端架构

新增独立模块 `src-tauri/src/services/distribution_fit.rs`：

- `FitModel` registry：domain validation、initialization、objective、parameter transform、PDF/CDF/quantile。
- `FitOptimizer`：统一 deterministic constrained optimization。
- `fit_distribution(...)`：单模型入口。
- `fit_all_distributions(...)`：候选执行、隔离失败、稳定排序。
- `build_fit_diagnostics(...)`：GOF 和图形坐标。

现有 `distribution_executor::PreparedObservationV1` 是唯一输入来源，继续复用 filter/By/Weight/Freq/budget 语义。`distribution_service.rs` 只负责 orchestration 和 report block 组装，不承载 MLE 数学。

不新增 Tauri command；沿现有 Distribution run request/result IPC 返回。

## 6. 前端与交互

### 6.1 Continuous Fit 菜单

Y 菜单增加 `Continuous Fit` 子菜单。最终目标条目：

- Fit Normal
- Fit Lognormal
- Fit Weibull
- Fit Exponential
- Fit Gamma
- Fit Cauchy
- Fit Student's t
- Fit SHASH
- Fit Johnson
- Fit Normal 2 Mixture
- Fit Normal 3 Mixture
- Fit Smooth Curve
- Fit All

菜单只显示 registry 标记为 implemented 的条目。阶段未完成的模型不显示为可执行选项，也不使用假 payload。

点击模型：

1. 更新 analysis config。
2. 增加 revision。
3. 自动启动新 run。
4. 当前结果在 updating 期间继续可见。
5. 新结果通过四键 identity 后替换。

再次点击已选模型表示 Remove Fit，并触发同样的受控 rerun。

### 6.2 报告结构

每个 fit 是 Y report 下的独立 disclosure：

- 标题与 compatibility 状态
- 参数估计表
- Fit Statistics 表
- GOF 表（阶段 2）
- Q-Q/CDF/P-P 诊断图（按显示偏好）
- convergence/warning 状态

Fit All 额外显示 comparison table，默认按 AICc 排序。Overview 叠加已启用且成功模型的 PDF 曲线，并显示可辨识 legend。模型颜色来自稳定 `distributionId -> theme color` 映射，不按返回顺序漂移。

显示/折叠、overlay visibility 和诊断图 visibility 是 presentation preferences，不增加 revision。

## 7. 兼容性策略

沿用四态：

- `documentedCompatible`
- `validatedCompatible`
- `compatibilityPending`
- `intentionalDifference`

初始实现状态：

- 公开闭式 MLE、PDF/CDF 和信息准则：可在独立公式 fixture 通过后标记 `documentedCompatible`，但该状态只说明公开公式，不自动等于 JMP 全流程兼容。
- optimizer、初始化、GOF、Weight、SHASH、Johnson、mixture、smooth curve：默认 `compatibilityPending`。
- 仅当脱敏 JMP 19 黑盒矩阵通过时，具体 method/version 才可标记 `validatedCompatible`。

浮点容差沿用 `abs <= 1e-10` 或 `rel <= 1e-9`；optimizer 参数另设 convergence tolerance，不得用 UI 四舍五入后的文本做数值比较。

## 8. 错误与边界

必须覆盖：

- 空组、全 missing、常量列
- 非正值进入正域模型
- effective N 不足
- 非 finite likelihood
- optimizer iteration limit
- 边界解
- singular Hessian
- Weight/Freq 非法值
- mixture component collapse
- cancellation、stale run 和并发 mutation

失败模型不生成伪曲线，不序列化 NaN/Infinity，不阻止其他模型返回。

## 9. 测试与验收

### 9.1 Rust

- 每个分布的参数恢复、domain、likelihood 和 curve golden tests。
- Weight/Freq replication 与 effective N tests。
- optimizer deterministic、convergence 和 failure tests。
- Fit All 排序、partial failure 和 cancellation tests。
- JSON 不含 NaN/Infinity。

### 9.2 TypeScript 与 archive

- request/config/result 合同。
- 旧项目缺省字段恢复。
- selected IDs 与 presentation preferences round-trip。
- unknown future fit payload preserved/isolated。

### 9.3 UI 与图形

- 菜单只显示真实 registry capability。
- 选择/移除模型触发一次受控 rerun。
- updating 保留旧报告。
- PDF overlay 与 histogram 共享 X 轴和 density Y 轴。
- 多曲线 legend、颜色和 extent 稳定。
- 参数、Fit Statistics、GOF 表具有完整表格线。
- failed/unavailable 模型显示明确原因。

### 9.4 门禁

每阶段至少运行：

- `npm run test:distribution`
- `npm run build`
- `cargo test --lib`
- `cargo clippy --lib -- -D warnings`，若仍被仓库既有基线阻塞则单独记录
- Tauri 实际运行 smoke
- desktop 与窄窗口截图验收

## 10. 非目标

- 本设计不包含离散分布拟合。
- 不在前端执行 MLE、GOF 或坐标计算。
- 不承诺高级模型在首次实现时与 JMP 数值一致。
- 不复制 JMP 菜单视觉或帮助内容。
- 不把 fit result 写入 project archive；只保存 config 与 presentation preferences。
- 不在阶段 1 实现 hypothesis tests、prediction interval 或 tolerance interval。

## 11. Scope 状态建议

用户审阅批准后：

- `FIT-01` 改为 `approved`，由阶段 1 交付。
- `FIT-03`、`FIT-04` 改为 `approved`，由阶段 2 交付。
- `FIT-05`、`FIT-07`、`FIT-08` 改为 `approved`，由阶段 2/3 交付。
- `FIT-02`、`FIT-06` 保持 `deferred`；它们属于离散或 zero-inflated 独立项目。

实现计划必须按阶段拆分，不允许阶段 3 阻塞阶段 1 的可用交付。
