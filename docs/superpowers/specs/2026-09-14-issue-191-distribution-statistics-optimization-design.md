# Issue 191 Distribution 统计参数优化设计

## 1. 目标与范围

本变更优化 Distribution Analysis 的统计报告、连续分布拟合和过程能力结果，覆盖 GitHub Issue #191 的五项要求：

1. Summary 不再显示 Mode。
2. Location 与 Variation 合并为 Summary Statistics，并移除 Minimum、Maximum、Range、Interquartile Range、Median Absolute Deviation。
3. Continuous Fit 不再显示 Compatibility pending 与 Convergence: Converged；报告中的颜色标记必须与 Distribution 图中的拟合曲线一致。
4. Within Capability 和 Overall Capability 提供 Cpm Lower/Upper confidence interval。
5. Distribution 设置恢复可选择的 Lognormal、Weibull、Cauchy 和 Fit All；新建分析默认仍只选择 Normal。

本变更不删除后端描述统计字段，不改变 Quantiles 表中的 Minimum/Maximum，也不声称新增方法已经达到 JMP 数值兼容。后端继续作为唯一统计计算权威，前端不得计算拟合参数或 Cpm 区间。

## 2. 已确认根因

- `DistributionReport.SummaryDataTables` 将 Location、Variation 和各统计行硬编码为两张表，属于展示层问题。
- `ContinuousFitReport` 主动渲染 compatibility provenance 和 convergence diagnostics；这些信息可以保留在 payload 中而不对用户展示。
- Rust 已实现 Normal、Lognormal、Exponential、Gamma、Weibull、Fit All comparison 和 fitted PDF packets；旧 `DistributionAnalysisConfig.fitDistributions` 默认只有 Normal，且对话框没有选择入口。
- Cauchy 只存在于历史规划，从未进入 Rust/TypeScript 分布枚举、fit registry 或报告本地化。
- `normal_capability::capability_intervals` 明确以 `capability.cpmIntervalDeferred.v1` 返回 Cpm unavailable；这不是 IPC 或渲染丢失。
- Graph Core 的 MODE A precomputed curve 路径使用 `DEFAULT_GROUP_KEY` 解析全部曲线样式，导致多条拟合曲线共用颜色，报告也没有可复用的颜色身份。

## 3. 报告结构

每个 response 的 `Overall` 保持 Quantiles 在前，随后只渲染一张 `Summary Statistics` 表。该表按以下固定顺序显示：

1. N
2. N Missing
3. Mean
4. Median
5. Std Dev
6. Std Error
7. Lower 95% Mean
8. Upper 95% Mean

Mode、Minimum、Maximum、Range、IQR、MAD 不进入该表。对应字段继续保留在 Rust 和 TypeScript payload 中，因为箱线图、Quantiles、兼容导入及后续可配置报告仍可能使用它们。

`Summary Statistics` 使用现有 `AnalysisTable`，不得引入原生 `<table>` 或 Distribution 专属表格组件。四种 locale 都增加或复用同一标题 key。

## 4. Continuous Fit 展示与颜色契约

成功的 Continuous Fit block 仅显示 Parameter Estimates、Measures 和模型必要说明。Compatibility 与 convergence 保留在 `DistributionFitDataV1` provenance/diagnostics 中，但不渲染为可见文本；失败或 unavailable 状态仍显示具体原因。

建立唯一的 `ContinuousDistributionIdV1` 显示顺序与颜色索引：

1. Normal
2. Cauchy
3. Lognormal
4. Weibull
5. Exponential
6. Gamma

颜色来自 Graph Theme 的 categorical palette，不在报告 CSS 中复制十六进制颜色。Normal 在默认主题下使用 palette 第一色，即蓝色。后端 fitted curve packet 的 `seriesId` 保持稳定，并携带可供前端解析的 distribution identity。Graph Core 以 distribution identity 而非 `DEFAULT_GROUP_KEY` 选择曲线颜色。

每个 Continuous Fit frame 标题前渲染一条短线 swatch，swatch 与对应 fitted curve 调用同一个纯函数解析 palette index。By group 或 response 分组不得改变同一 distribution 的颜色；同一图中的不同 distribution 必须有不同颜色。失败且没有曲线的 block 仍可显示其分布 swatch，便于保持报告顺序稳定。

## 5. Continuous Fit 配置合同

`DistributionAnalysisConfig` 增加显式 `fitAll: boolean`，同时保留 `fitDistributions: ContinuousDistributionIdV1[]`：

- 新建分析：`fitDistributions: ["normal"]`、`fitAll: false`。
- 旧文档缺少 `fitAll`：迁移为 `false`，不改变既有结果。
- `fitAll: false`：只计算 `fitDistributions` 中去重后的已注册分布。
- `fitAll: true`：计算 registry 中全部分布并生成一个 comparison block；此时 `fitDistributions` 保留用户最近的显式选择，但不参与本次候选集合。
- 不使用字符串 `"all"` 冒充分布 ID。

Distribution 编辑器使用 checkbox 列表选择单个分布，并使用独立 checkbox 控制 Fit All。启用 Fit All 时保留但禁用单项选择；关闭后恢复用户先前选择。保存时至少满足“Fit All 为 true”或“选中一个分布”，否则显示配置错误。

该字段必须贯通 Analysis document、migration、request fingerprint、legacy `DistributionRequest`、Rust `DistributionContinuousFitConfigV1`、archive validator 和测试 fixtures。现有 V1 request 的 `enabledDistributionIds` 与 `fitAll` 语义保持不变。

## 6. Cauchy 拟合方法

新增两参数 Cauchy location-scale 模型：

$$
f(x;x_0,\gamma)=\frac{1}{\pi\gamma\left[1+\left(\frac{x-x_0}{\gamma}\right)^2\right]},\qquad \gamma>0.
$$

参数 ID 为 `location` 和 `scale`，parameterization ID 为 `cauchy.locationScale.v1`。拟合使用全部有效 observation 的 `frequency * weight` 作为 likelihood contribution。

优化在 $(x_0,\log\gamma)$ 空间执行，保证 scale 始终为正。初始化使用 weighted median 与基于 weighted IQR 的正 scale；常量样本、非有限目标值、迭代上限和非正 scale 均通过既有 typed failure contract 返回，不得 panic 或静默回退为 Normal。

为降低 Cauchy likelihood 局部极值风险，使用固定、可复现的多起点集合：weighted median，以及 weighted Q1、Q3 作为 location 起点；scale 起点使用 IQR/2 与样本范围的稳定正下界。每个起点执行相同容差和迭代上限，选择有限 negative log-likelihood 最小者。provenance 记录 optimizer ID、版本、初始化策略和候选 registry。

参数 standard error 与 95% interval 使用最优点处 $(x_0,\log\gamma)$ 的数值 observed-information Hessian。Hessian 非正定、奇异或产生非有限值时，仅参数推断字段返回 typed unavailable，point estimate、likelihood、信息准则和曲线仍保持 available。

Cauchy PDF curve 使用现有 Rust `build_pdf_curve` 和 precomputed curve packet 链路。Fit All comparison 继续按 AICc、AIC、BIC 与稳定 distribution order 输出，并隔离单个模型的 domain/optimizer failure。

## 7. Cpm Confidence Interval

Cpm point estimate保持现有定义。令 $LSL$、$USL$ 和 $T$ 分别表示规格下限、规格上限和 Target，$\bar{x}$ 表示样本均值，$s$ 表示对应的 Within 或 Overall sigma estimator，$n$ 表示有效 observation 数。再令

$$
d=\bar{x}-T,\qquad q=s^2+d^2,\qquad
Cpm=\frac{USL-LSL}{6\sqrt{q}}.
$$

本版本使用明确标注的 log-delta approximation，不伪装为 exact/JMP-compatible。对 sigma estimator 的有效自由度 $\nu$，使用 plug-in variance：

$$
\operatorname{Var}(q)\approx\frac{2s^4}{\nu}+\frac{4d^2s^2}{n},
$$

$$
SE_{\log Cpm}=\frac{\sqrt{\operatorname{Var}(q)}}{2q},
$$

$$
[Cpm_L,Cpm_U]=Cpm\exp\left(\mp z_{1-\alpha/2}SE_{\log Cpm}\right).
$$

其中 confidence level 为 $1-\alpha$，$z_{1-\alpha/2}$ 为标准正态分布的对应 quantile，$Cpm_L$ 与 $Cpm_U$ 分别为区间下限和上限。

- Within 使用现有 moving-range effective degrees of freedom 与 `withinSigma`。
- Overall 使用 $\nu=n-1$ 与 `overallSigma`。
- confidence level 使用分析级设置，不硬编码 95%。
- n < 3、缺少双侧规格、缺少 Target、sigma 不可用、$q\le0$ 或任一中间值非有限时，复用 typed unavailable/notApplicable 规则。
- 区间保持正值，不截断或替换有限结果。

interval method ID 分别为 `movingRangeEffectiveDfLogDeltaCpm.v1` 和 `logDeltaCpm.v1`。Capability interval provenance 的 method version 从 `1.1.0` 升级，并在 parameterization 中列出 Cpm log-delta approximation。原 `capability.cpmIntervalDeferred.v1` 仅用于读取旧 fixture，不再由新计算生成。

## 8. 错误处理与兼容性

- Rust 继续返回 `Result<T, AppError>`，所有数值失败转换为既有 typed state 或 `AppError::Stats`；非测试代码不得使用 `unwrap()`/`expect()`。
- Cauchy 和 Fit All 不改变旧文档默认行为。归档迁移只补默认字段，不持久化计算结果。
- 未知 distribution ID 必须在前端配置校验、Rust request 校验和 archive validator 中失败，不能映射为 Normal。
- Compatibility provenance 保留原值；隐藏可见文本不等于升级兼容状态。
- 图表仍使用 Rust 生成的 fitted curve，前端不得重新计算 PDF。

## 9. 测试与验收

### 前端合同与迁移

- 默认分析仍只选择 Normal，`fitAll` 为 false。
- 缺少 `fitAll` 的旧文档迁移为 false。
- Cauchy 在 TypeScript registry、locale 和 archive contract 中完整注册。
- request identity/fingerprint 包含 `fitAll`，防止旧结果越过 stale fence。

### 报告与图表

- Summary Statistics 精确包含八行，且不出现被移除的六项统计量。
- 成功拟合不显示 Compatibility pending 或 Convergence: Converged；失败原因仍可见。
- Normal/Cauchy/Lognormal/Weibull 的 swatch 与 fitted curve 颜色逐一相同，多曲线颜色互异。
- desktop 与 narrow viewport 下表格、swatch、标题和图例无重叠或页面级横向溢出。

### Rust 统计

- Cauchy synthetic fixture 恢复 location/scale、输出有限 likelihood/criteria/curve，并在重复运行中确定性一致。
- Cauchy 常量样本、极端值、weighted/frequency observation 和 Hessian singular 分支返回正确 typed state。
- Fit All 包含全部六个 registry 分布，单模型失败不阻断其他结果和 comparison。
- Cpm Within/Overall 区间与独立手算 fixture 一致；不同 confidence level 单调扩宽；缺少 Target、单侧规格、n < 3 和 sigma zero 返回正确 state/reason。

### 必跑命令

- `npm run test:distribution`
- `npm run test:analysis:typecheck`
- `npm run test:analysis:contracts`
- `npm run test:analysis:kinds`
- `npm run test:analysis:ui`
- `npm run test:analysis`
- `cargo test --manifest-path src-tauri/Cargo.toml services::distribution_fit`
- `cargo test --manifest-path src-tauri/Cargo.toml services::normal_capability`
- `cargo test --manifest-path src-tauri/Cargo.toml services::distribution_service`
- `cargo test --manifest-path src-tauri/Cargo.toml analysis_kind_manifest_matches_validator_contracts`
- `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`
- `npm run build`

最终还需启动本地应用，对包含 By group、多个 response、Normal+Cauchy+Lognormal+Weibull 和 Fit All 的分析执行桌面与窄宽视觉验收。