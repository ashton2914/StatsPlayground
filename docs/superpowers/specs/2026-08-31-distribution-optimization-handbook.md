# Distribution 模块优化设计手册

**日期：** 2026-08-31
**状态：** 已批准
**用途：** 作为后续 session 制定实施计划和执行 Distribution 优化的统一输入
**适用范围：** Continuous Distribution 的显示选项、Histogram、诊断图、推断功能、Continuous Fit 与 Fit Normal
**目标基准：** JMP Pro 19.0 可观察行为，配合公开统计定义和 StatsPlayground 自有产品设计

**依赖文档：**

- [Distribution 总体设计](2026-08-25-analysis-distribution-design.md)
- [Distribution 批准范围与验收台账](2026-08-26-analysis-distribution-approved-scope.md)
- [Continuous Descriptive Methods V1](2026-08-26-distribution-continuous-descriptive-methods-v1.md)
- [Normal Process Capability V1](2026-08-26-distribution-normal-capability-method-v1.md)
- [Distribution Formal Report Design](2026-08-27-distribution-formal-report-design.md)
- [Distribution Visual Diagnostics Design](2026-08-27-distribution-visual-diagnostics-jmp19-design.md)
- [Distribution Continuous Fit Design](2026-08-28-distribution-continuous-fit-jmp19-design.md)
- [Visual Diagnostics 验收记录](../artifacts/2026-08-27-distribution-visual-diagnostics-acceptance.md)
- [Continuous Fit Stage 1 验收记录](../artifacts/2026-08-30-distribution-continuous-fit-stage-1-acceptance.md)
- [Fit Inference 与诊断移除验收记录](../artifacts/2026-08-31-distribution-fit-inference-and-diagnostics-removal-acceptance.md)

## 1. 手册定位

本手册整理 JMP Distribution 菜单中与当前 StatsPlayground 产品有关的功能，回答以下问题：

1. 哪些能力必须保留或优先优化。
2. 每个功能解决什么统计问题。
3. 计算应遵循什么公开、可审计的方法。
4. 哪些行为已经实现、哪些仍待验收、哪些明确暂缓。
5. 后续 session 应如何拆分工作，而不重复推导产品边界。

本手册不是 JMP 帮助文档，也不授权复制 JMP 的界面、文案、素材、代码或未公开算法。截图只能证明菜单项和可观察输出存在，不能单独证明其内部计算方法。凡 JMP 细节尚无公开定义或脱敏黑盒数值证据，必须保持 `compatibilityPending`，不得写成已兼容。

## 2. 文档权威顺序与现状口径

当仓库文档之间出现状态差异时，采用以下权威顺序：

1. 日期更新且包含逐项状态的批准范围与验收台账。
2. 对应阶段的验收记录。
3. 独立 method spec。
4. 阶段设计。
5. 总体设计中的长期目标或早期范围描述。

因此，本手册采用以下当前事实：

- Quantiles、Core Summary、Histogram、Tukey Box、ECDF 已实现并通过自动门禁，产品 UI 验收仍为 `pending`。
- Normal Quantile Plot 已实现并通过自动门禁；Letter-Value Quantile Plot 与 Stem-and-leaf 已按后续产品决策从 runtime、contracts 和 UI 彻底移除。
- Normal、Lognormal、Exponential、Gamma、Weibull、Fit All、信息准则和 fitted PDF overlay 已完成 Continuous Fit Stage 1 自动验收，产品 UI 验收仍为 `pending`。
- Normal Process Capability 已实现并通过自动门禁，产品 UI 验收仍为 `pending`。
- JMP 术语与方法对齐 Stage 1 已实现；后续 Fit Inference 阶段已为五模型自由参数增加固定 95% SE/CI，兼容状态保持 `compatibilityPending`。
- Test Mean、Test Std Dev、Prediction Interval、Equivalence 和 Tolerance Interval 当前仍为 `deferred`。
- Continuous Fit Stage 2 的 GOF、Cauchy、Student's t 和模型诊断已批准或规划，但尚未实现。

批准范围台账中的 Stem、Letter-Value 与 Continuous Fit 状态冲突已按后续产品决策修正；removed 能力不得重新进入 registry 或 UI。

## 3. 优先级与状态模型

### 3.1 产品优先级

| 优先级 | 定义 | 处理规则 |
| --- | --- | --- |
| P0 必须 | 构成连续分布分析的核心闭环，或当前已经批准并交付 | 保留、补齐验收、优先修复正确性和可用性问题 |
| P1 应该 | 对专业分析有明显价值，但不阻塞首个稳定版本 | 在 P0 UI 验收完成后按独立 method spec 实施 |
| P2 低优先级 | 低频、高复杂度、可被其他能力替代，或缺乏可靠算法证据 | 未实现项保持 deferred；已实现项可保留，但不优先扩展或追求外观兼容 |

### 3.2 生命周期状态

每项能力必须同时记录：

- `scopeStatus`: `approved | deferred | rejected`
- `developmentStatus`: `notStarted | specified | implementing | implemented`
- `automationStatus`: `notStarted | passing | failing`
- `uiAcceptance`: `notReady | pending | passed | failed`
- `compatibilityStatus`: `documentedCompatible | validatedCompatible | compatibilityPending | intentionalDifference`

前四项严格沿用批准范围台账的枚举；`compatibilityStatus` 是方法证据维度，不替代其中任何一项。`implemented` 不等于 `uiAcceptance=passed`，自动截图或组件测试也不能替代正式 Tauri 界面的人工验收。

## 4. 推荐的核心用户体验

连续变量报告默认形成一个紧凑、可扫描的分析闭环：

1. **Overview**：Histogram 与 Tukey Outlier Box Plot 共用 value axis。
2. **Quantiles + Summary Statistics**：宽屏横向、窄屏纵向。
3. **Process Capability**：仅在存在有效 LSL 或 USL 时默认出现。
4. **Diagnostics**：Normal Quantile 与 ECDF 默认关闭，由用户按需开启；Letter-Value Quantile Plot 与 Stem-and-leaf 不再提供。
5. **Continuous Fit**：仅显示 capability registry 中真实可执行的模型。

显示开关、报告折叠、横向布局、Histogram scale、fit overlay 和 details visibility 都是 presentation preference：

- 立即生效。
- 随项目保存。
- 不增加 `configRevision`。
- 不触发后端重新计算。

Histogram method、Fixed Count、Fixed Width、拟合模型选择、测试参数和区间参数属于 calculation config：

- 修改时增加 `configRevision`。
- 取消旧 run。
- 保留旧有效报告直到新结果提交。
- 只接受与四键 identity 匹配的新结果。

## 5. Display Options 优化设计

### 5.1 功能决策矩阵

| 功能 | 用户价值 | 优先级 | 当前状态 | 优化决策 |
| --- | --- | --- | --- | --- |
| Quantiles | 读取中位数、尾部与关键百分位 | P0 | 已实现 | 保留默认开启 |
| Set Quantile Increment | 按统一增量生成大量概率点 | P2 | 未批准 | 不进入当前菜单 |
| Custom Quantiles | 查询用户指定概率点 | P1 | 未实现 | 后续独立规格，不与默认表混杂 |
| Summary Statistics | 查看中心、离散、样本量和区间 | P0 | 已实现 | 保留默认开启 |
| Customize Summary Statistics | 控制报告字段密度 | P1 | 未实现 | 先稳定扩展统计合同，再实现显示定制 |
| Horizontal Layout | 提高宽屏报告扫描效率 | P0 UI | 已实现 | 改名为 Horizontal Tables，窄屏自动纵向 |
| Axes on Left | 改变 JMP 报告轴位置 | P2 | 不适用 | 不复制；由 Graph Builder 自适应布局 |

### 5.2 Quantiles

当前批准概率点为：

$$
0, 0.005, 0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975, 0.995, 1.
$$

基线使用 weighted Hyndman-Fan Type 6。无 Weight/Freq 时，对排序样本计算：

$$
h=(n+1)p,
$$

将 $h$ 截断到 $[1,n]$，再在线性相邻 order statistics 之间插值。Weight/Freq 使用已冻结的累计贡献 knot 规则，不得改用 DuckDB `QUANTILE_CONT`，因为其默认语义不是 Type 6。

优化要求：

- 默认表保持紧凑，不因 P1 的 Custom Quantiles 扩张。
- 概率、估计值和状态使用 typed payload，不从格式化文本反解析。
- $p=0$ 和 $p=1$ 分别返回最小值和最大值。
- empty group 返回 unavailable；单点组所有分位数等于该值。

### 5.3 Summary Statistics

P0 字段：

- Mean
- Sample Std Dev
- Std Error Mean
- Mean Confidence Interval
- N
- N Missing
- Minimum
- Maximum
- Median
- Mode
- Range
- IQR
- MAD

加权均值：

$$
\bar{x}=\frac{\sum_i f_iw_ix_i}{W}.
$$

混合 frequency/reliability weight 方差分母：

$$
D=W-\frac{W_2}{W},
\qquad
s^2=\frac{\sum_i f_iw_i(x_i-\bar{x})^2}{D}.
$$

Std Error 和均值置信区间：

$$
SE=\frac{s}{\sqrt{n_{eff}}},
\qquad
\bar{x}\pm t_{1-\alpha/2,n_{eff}-1}SE.
$$

优化要求：

- 不能把 MLE scale 与 sample Std Dev 混用。
- `D <= 0` 时 Std Dev、SE 和 Mean CI 使用 typed unavailable。
- Mode ties 全部保存在 payload；仅唯一众数显示数值，并列或全异样本显示 `No unique mode`。
- Customize Summary Statistics 只控制展示，不改变已计算结果；新增高成本统计量时才进入 calculation config。

## 6. Histogram Options 优化设计

### 6.1 功能决策矩阵

| 功能 | 意义 | 优先级 | 优化决策 |
| --- | --- | --- | --- |
| Histogram | 展示分箱后的分布形态 | P0 | 默认开启 |
| Shadowgram | 降低单一 bin width/anchor 对形态的影响 | P2 | 不实现 JMP Shadowgram；优先 Smooth Curve/KDE |
| Vertical | 改变 value axis 和条形方向 | P1 UI | 仅在布局确有需求时增加，不复制 JMP 命名 |
| Std Error Bars | 表示 bin count/probability 的抽样不确定性 | P2 | 算法语义冻结前不实现 |
| Set Bin Width | 用户控制分箱宽度 | P0 | 作为 calculation config |
| Histogram Color | 控制图形颜色 | P1 UI | 归 Graph Builder/theme，不进入统计合同 |
| Count Axis | 显示每箱贡献数 | P0 | 通过 scale selector 切换 |
| Prob Axis | 显示每箱概率 | P0 | 通过 scale selector 切换 |
| Density Axis | 显示单位宽度概率密度 | P0 | Fit overlay 时自动使用 |
| Show Percents | 显示百分比标签 | P1 UI | 默认关闭，避免标签拥挤 |
| Show Counts | 显示 count 标签 | P1 UI | 默认关闭，tooltip 始终可用 |

### 6.2 方法选择

Histogram method 使用下列明确选项：

- Automatic
- Freedman-Diaconis
- Scott
- Sturges
- Fixed Count
- Fixed Width

UI 不应宣称 Automatic 与 JMP Auto 相同。当前 `jmpAuto` 实际回退到 FD，应在 UI 或 provenance 中保持 `compatibilityPending`；若产品名称继续使用 Automatic，method ID 仍必须暴露真实算法来源。

Freedman-Diaconis：

$$
h_{FD}=2\,IQR\,n_{eff}^{-1/3}.
$$

Scott：

$$
h_{Scott}=3.5s\,n_{eff}^{-1/3}.
$$

Sturges：

$$
k=\max\left(1,\left\lceil\log_2(n_{eff})+1\right\rceil\right).
$$

当前 fallback 顺序保持：FD → Scott → Sturges → constant-column single bin。

### 6.3 Bin 和 scale 合同

每个 bin 由 Rust 返回：

- `lower`
- `upper`
- `count`
- `probability`
- `density`
- boundary inclusion metadata

定义：

$$
count_j=\sum_{x_i\in B_j}f_iw_i,
$$

$$
probability_j=\frac{count_j}{W},
$$

$$
density_j=\frac{count_j}{W\,h_j}.
$$

要求：

- 普通 bins 为 $[lower,upper)$，最后一箱右闭。
- 必须输出空 bins。
- Graph Builder 不重新分箱、不修正边界、不重新归一化。
- scale 切换只选择后端已有字段，不触发 rerun。
- fitted PDF 只能叠加到 density scale；切换到 fit overlay 时，UI 应自动切换 density 或明确禁用 overlay，而不能错误地把 PDF 画到 count axis。
- Fixed Count 必须校验正整数和资源上限。
- Fixed Width 必须校验 finite、严格大于 0，并限制最大 bin 数。

### 6.4 推荐交互

Histogram 面板使用：

- 单选菜单或 segmented control 选择 method。
- `Count / Probability / Density` segmented control 选择 scale。
- Fixed Count 使用整数输入。
- Fixed Width 使用带单位语义的数值输入。
- Specification Lines 和 Outlier Box Plot 使用 checkbox/toggle。
- 颜色由主题或图表设置统一管理，不放进统计菜单。

## 7. Normal Quantile Plot

### 7.1 统计意义

Normal Quantile Plot 用于观察样本分位数与理论标准正态分位数是否近似线性对应。它是图形诊断，不是正式的正态性假设检验。

对排序后的有效观测 $x_{(i)}$，当前 normal score 定义为：

$$
p_i=\frac{r_i}{N+1},
\qquad
z_i=\Phi^{-1}(p_i).
$$

绘图坐标为 $(z_i,x_{(i)})$。横轴可显示 probability label，但实际位置必须由 $z_i$ 决定，不能按概率文本等距排列。

### 7.2 解读规则

- 点接近参考线：样本与正态模型较一致。
- S 形：尾部厚度与正态分布不同。
- 单方向弯曲：可能存在偏态。
- 个别远离：潜在异常点。
- 置信带只用于辅助判断，不能替代 GOF 的 p-value 和方法状态。

### 7.3 产品要求

优先级为 **P0 诊断能力，默认关闭**。

- normal score 公式可标记 `documentedCompatible`。
- ties rank、参考线和 95% pointwise band 在脱敏黑盒矩阵通过前保持 `compatibilityPending`。
- Freq 使用逻辑 rank，不物理展开。
- Weight 当前返回 `normalQuantile.weightUnsupported.v1`。
- 最多输出 2,000 个绘图点；降采样只能发生在全部 rank 和诊断值计算完成之后。
- 确定性 rank grid 必须保留两端、中心和规格限邻域。
- Rust 返回 points、reference line 和 confidence band；Graph Builder 只映射坐标。

## 8. Stem-and-leaf（Removed）

该能力已按 2026-08-31 产品决策彻底移除。当前 runtime 不计算或返回 Stem-and-leaf payload，UI、偏好、i18n、组件和活动 compatibility fixture 均不再包含该能力。旧项目中的 `stemAndLeaf` 偏好键在加载时丢弃。

## 9. Letter-Value Quantile Plot（Removed）

该能力已按 2026-08-31 产品决策彻底移除。当前 runtime 不计算或返回 Quantile Box payload，IPC chart union、graph adapter、UI、偏好、i18n 和活动 compatibility fixture 均不再包含该能力。旧项目中的 `quantileBoxPlot` 偏好键在加载时丢弃。

## 10. ECDF/CDF Plot

### 10.1 统计意义

经验累积分布函数表示观测值小于等于 $x$ 的累计比例：

$$
\widehat F(x)=\frac{\sum_i f_iw_iI(x_i\le x)}{W}.
$$

无 Weight/Freq 时退化为：

$$
\widehat F(x)=\frac{\#\{x_i\le x\}}{N}.
$$

ECDF 可用于读取：

- 低于 LSL 的经验比例。
- 小于等于 Target 的累计比例。
- 大于 USL 的经验比例 $1-\widehat F(USL)$，边界语义需与 observed nonconformance 一致。
- 分布位置、离散、偏态和尾部。
- empirical CDF 与 fitted CDF 的差异。

### 10.2 产品要求

优先级为 **P0 计算能力，默认关闭的可选图表**。

- 相同值按 contribution 聚合成一次 jump。
- 输出起点 `{x=min, probability=0}`。
- 输出每个唯一值的跳变前后坐标。
- 最终概率必须严格为 1，允许使用显式端点修正避免浮点累计误差。
- Graph Builder 使用 step-after，不插值、不平滑。
- LSL、Target、USL 是参考线，不参与 ECDF 计算。
- Weight 整体缩放不改变 ECDF。
- fitted CDF 属 Continuous Fit Stage 2 诊断，不应覆盖或替代 empirical CDF block。

## 11. 推断、预测与容忍区间路线

这些能力当前均不得作为可执行空入口显示。恢复开发前，必须更新 scope 并新增独立 method spec。

### 11.1 决策矩阵

| 功能 | 统计问题 | 优先级 | 当前状态 | 推荐顺序 |
| --- | --- | --- | --- | --- |
| Test Mean | 总体均值是否等于指定值 | P1 | deferred | 1 |
| Test Std Dev | 正态总体标准差是否等于指定值 | P1 | deferred | 2 |
| Prediction Interval | 未来一个或多个观测可能落在哪里 | P1 | deferred | 3 |
| Test Equivalence | 参数是否落入实际等效界限 | P2 | deferred | 4 |
| Tolerance Interval | 以指定置信度覆盖总体指定比例 | P2 | deferred | 5 |

### 11.2 Test Mean

经典单样本 t 检验：

$$
t=\frac{\bar{x}-\mu_0}{s/\sqrt{n}}.
$$

method spec 必须冻结：

- 单尾和双尾假设。
- confidence level。
- Weight/Freq 下的 $n_{eff}$、自由度和方差语义。
- $n<2$、常数列、非有限结果。
- estimate、null value、difference、SE、DF、test statistic、p-value 和 CI 字段。

### 11.3 Test Std Dev

仅在正态总体假设下，经典统计量为：

$$
\chi^2=\frac{(n-1)s^2}{\sigma_0^2}.
$$

必须在 UI 明确显示 Normality assumption。Weight/Freq 的自由度和参考分布在独立规格批准前不得推断。

### 11.4 Test Equivalence

推荐采用 TOST 框架。均值差异 $\theta$ 的等效区间为 $(L,U)$，需要同时拒绝：

$$
H_{01}:\theta\le L,
\qquad
H_{02}:\theta\ge U.
$$

只有两侧检验都通过才能声明等效。不能把“普通显著性检验不显著”解释为等效。

### 11.5 Prediction Interval

正态独立单个未来观测的常见形式：

$$
\bar{x}\pm t_{1-\alpha/2,n-1}s\sqrt{1+\frac{1}{n}}.
$$

实现前必须区分：

- 单个未来观测。
- 多个未来观测的 simultaneous coverage。
- 未来样本均值。
- 单侧与双侧区间。

不能与 mean confidence interval 共用标题或 payload kind。

### 11.6 Tolerance Interval

Tolerance interval 的语义是：以置信度 $\gamma$ 覆盖总体至少比例 $P$。它不同于：

- Mean CI：估计总体均值。
- Prediction interval：预测未来观测。
- Specification limits：工程要求，不是样本估计。

由于参数法、非参数法、单侧/双侧、coverage/confidence 参数和小样本算法差异较大，本项保持 P2，必须独立冻结 method spec。

## 12. Continuous Fit 与 Fit Normal

### 12.1 当前 Stage 1 基线

已实现模型：

- Normal
- Lognormal
- Exponential，location 固定为 0
- Gamma，shape/scale
- Weibull，shape/scale
- Fit All

已实现报告：

- Parameter Estimates：Estimate、Std Error、Lower 95%、Upper 95%；固定 location 不输出
- Normal Location/Dispersion；Lognormal Scale/Shape（natural-log parameterization）；Gamma/Weibull Shape/Scale
- Measures：`-2*LogLikelihood`
- AICc
- BIC
- fitted PDF overlay
- typed convergence、domain failure 和 unavailable
- Fit comparison

AIC 继续保留在 typed payload 与 Fit All fallback 排序中，但不在单模型默认 Measures 表显示。五模型自由参数使用固定 95% Wald limits；推断失败只使 SE/limits typed unavailable，不影响 Estimate、fit 或 PDF。

### 12.2 Fit Normal 参数化

Normal fit 使用：

$$
X\sim N(\mu,\sigma^2),\qquad \sigma>0.
$$

加权 log-likelihood：

$$
\ell(\mu,\sigma)=\sum_i f_iw_i\log p(x_i\mid\mu,\sigma).
$$

闭式 MLE：

$$
\widehat\mu=\frac{\sum_i f_iw_ix_i}{W},
$$

$$
\widehat\sigma_{MLE}=
\sqrt{\frac{\sum_i f_iw_i(x_i-\widehat\mu)^2}{W}}.
$$

报告必须明确 $\sigma$ 是 MLE scale，不能与 Summary Statistics 中使用无偏分母的 sample Std Dev 混淆。

### 12.3 子功能决策矩阵

| JMP 可观察菜单项 | 意义 | 优先级 | 项目决策 |
| --- | --- | --- | --- |
| Density Curve | 在 density histogram 上叠加 fitted PDF | P0 | 已实现，保留 |
| Diagnostic Plots | 模型特定 Q-Q、CDF、P-P | P1 | Continuous Fit Stage 2 |
| Profilers | 交互查询 PDF/CDF/quantile 与参数变化 | P2 | 当前不实现 |
| Save Columns | 保存 fitted score/probability/quantile | P2 | 只能通过 versioned formula AST |
| Goodness of Fit | 评价模型充分性 | P1 | Stage 2 优先能力 |
| Fix Parameters | 固定部分参数后重新拟合 | P2 | 需约束拟合 method spec |
| Process Capability | 基于规格限和分布估计评价过程能力 | P0 | Normal capability 已独立实现 |
| Remove Fit | 删除已选模型并重新运行 | P0 UI | 保留 |

### 12.4 Fit statistics

令 $k$ 为自由参数数，$n_{eff}$ 为有效样本量：

Stage 1 中 Normal、Lognormal、Gamma、Weibull 使用 $k=2$；Exponential 的 location 固定为 0，因此使用 $k=1$，不能按参数显示行数推断 $k$。

$$
AIC=2k-2\ell,
$$

$$
AICc=AIC+\frac{2k(k+1)}{n_{eff}-k-1},
$$

$$
BIC=k\log(n_{eff})-2\ell.
$$

当 $n_{eff}\le k+1$ 时，AICc 返回 unavailable，不得序列化 Infinity 或 NaN。

Fit All 排序：

1. 可用 AICc 升序。
2. AICc 不可用时按可用 AIC 升序。
3. 容差内相同时按 `distributionId` 升序。
4. failed/unavailable 放在成功模型之后。

信息准则用于相对比较候选模型，不是绝对 GOF，也不意味着排名第一的模型一定适合数据。

当前 Stage 1 的 reliability Weight 语义存在已知风险：若所有 Weight 同乘常数，加权 log-likelihood 会同比缩放，而 Kish $n_{eff}$ 不变，AIC/AICc/BIC 及模型差值可能改变。这不只是 JMP 兼容问题，也会影响 StatsPlayground 内部模型选择的一致性。

Phase A 采用保守门禁：存在 Weight 时，允许输出 scale-invariant 的参数估计和 fitted PDF；LogLikelihood、AIC、AICc、BIC 与 Fit All 排名返回 typed unavailable，并说明 `fit.weightedInformationCriteriaUndefined.v1`。不得通过隐藏警告继续给出可排序数值，也不得静默归一化 Weight。后续只有在独立 method-spec revision 明确批准 normalized reliability likelihood 后，才能重新开放这些指标，并必须通过 Weight 整体缩放不变的黄金测试。

### 12.5 Density Curve

- Rust 在统一 X extent 上生成有序 PDF coordinates。
- Graph Builder 不计算 PDF。
- PDF 与 Probability Density Histogram 共用 X/Y axis。
- 曲线面积语义为 1，不按 count 放大。
- 多模型颜色由稳定 `distributionId -> theme color` 映射。
- 单模型失败不能阻塞其他模型或清空旧有效结果。

### 12.6 Goodness of Fit

Stage 2 推荐顺序：

1. Anderson-Darling：通用连续拟合诊断，强调尾部差异。
2. 模型特定 Q-Q、fitted CDF 与 P-P。
3. Pearson chi-square：仅在 expected bin counts 满足条件时可用。
4. Shapiro-Wilk：只作为 Normal fit 的辅助正态性诊断，不参与所有模型的统一排名。

GOF method spec 必须冻结 estimated-parameter correction、p-value 算法、ties、Weight/Freq、small sample 和模拟随机种子。不能直接调用 crate 默认方法后宣称兼容。

### 12.7 Fix Parameters、Save Columns 与 Profilers

这三项不进入近期实施：

- Fix Parameters 会改变自由参数数、优化约束、信息准则和可识别性。
- Save Columns 必须保存可重算公式定义，不得生成无来源静态副本。
- Profilers 需要新的交互与状态模型，且不能让 React 重新实现 PDF/CDF/inverse CDF。

恢复时应各自形成独立设计，不作为 Fit Normal 菜单的占位入口。

## 13. Process Capability 与 Fit Normal 的边界

Normal Process Capability 与 Fit Normal 使用相同的 Normal 分布原语，但解决不同问题：

- Fit Normal 判断正态模型如何描述数据，并提供模型参数、比较和诊断。
- Process Capability 比较过程分布与 LSL/Target/USL，并输出能力指数与超规比例。

边界规则：

- Capability 默认读取 Table 列属性规格。
- 手工规格只覆盖当前分析，不回写 Table。
- 仅 Target 不启用 capability。
- 至少存在有效 LSL 或 USL 才显示 capability。
- 双侧规格必须满足 `LSL < USL`。
- Capability 的 Within Sigma 使用 average moving range；Overall Sigma 使用整体 sample variation。
- Stability Index 定义为 Overall Sigma / Within Sigma，并携带独立 method provenance。
- Capability indices 与区间默认固定显示 3 位小数；Nonconformance 默认以 Observed/Expected Within/Expected Overall 百分比呈现，比例是显示权威源。
- Fit Normal 的 MLE scale 不得静默替代 capability 已冻结的 Within/Overall Sigma。
- 两个 block 可以共享 Normal CDF/PDF primitives，但必须保持不同 method IDs 和 provenance。

## 14. Weight、Freq、By、Missing 与边界样本

### 14.1 Observation contribution

每条有效源行贡献：

$$
c_i=f_iw_i.
$$

- Y 缺失或非有限时排除，并计入 `nMissing`。
- Freq 缺失或为 0 时排除该行；负值、非整数或非有限值使全局请求失败。
- Weight 缺失或为 0 时排除该行；负值或非有限值使全局请求失败。
- 无 Freq 时 $f_i=1$；无 Weight 时 $w_i=1$。
- Freq 实现不得物理展开无界数组。

定义：

$$
W=\sum_i f_iw_i,
\qquad
W_2=\sum_i f_iw_i^2,
\qquad
N_F=\sum_i f_i,
\qquad
n_{eff}=\frac{W^2}{W_2}.
$$

报告中的 `N` 为 $N_F$；`N Missing` 只表示 Y 缺失或非有限。因 Weight/Freq 缺失或为 0 而排除的行必须进入独立 eligibility counters，不得混入 `N Missing`。

### 14.2 功能支持矩阵

| 功能 | Freq | Weight | 备注 |
| --- | --- | --- | --- |
| Quantiles | 支持 | 支持 | 使用累计 contribution knots |
| Summary | 支持 | 支持 | 使用冻结的 $D$ 与 $n_{eff}$ |
| Histogram | 支持 | 支持 | count 表示 contribution |
| Tukey Box | 支持 | 支持 | quartiles 使用 weighted Type 6 |
| ECDF | 支持 | 支持 | Weight scale invariant |
| Normal Quantile | 支持 | 暂不支持 | typed unavailable |
| Continuous Fit | 支持 | 部分支持 | Weight 下参数/PDF 可用；信息准则与 Fit All 排名在语义冻结前 unavailable |

### 14.3 退化样本

- empty group：全部 block unavailable。
- 单点：mean/min/max/median/mode、histogram/box/ECDF 可用；variance/SE/CI unavailable。
- constant column：descriptive blocks 可用；Histogram 使用单 bin fallback。
- Fit scale 退化为 0 时，不能返回非法 Normal distribution；应返回 typed unavailable 或 model-specific failure。
- 所有可序列化数值必须 finite。

### 14.4 By 与过滤

- 所有 block 必须读取同一 immutable snapshot。
- By group 顺序必须稳定且显式，不依赖 DuckDB 默认排序。
- Filter、By、Y、Weight、Freq 使用稳定 column IDs。
- 不允许前端传 SQL、表名或表达式片段。
- 同一 group/Y 的 histogram、quantiles、box、ECDF 与 fits 应共享已准备样本和排序结果。

## 15. 架构责任边界

### 15.1 DuckDB Data Executor

负责：

- 根据稳定 column IDs 解析元数据。
- 将 versioned `FilterExpr` 编译为参数化查询。
- 建立 immutable snapshot 的 By 分区和稳定 row order。
- 准备 Y、Weight、Freq 与 eligibility counters。
- 输出 `distribution_executor::PreparedObservationV1` 或等价版本化 prepared sample。

Statistics Kernel、Continuous Fit 和 Capability 必须消费同一 prepared sample，不得各自重新解释 missing、zero Weight/Freq 或 By ordering。

### 15.2 Rust Statistics Kernel

负责：

- 消费 executor 已验证的 observation contribution。
- 对 prepared sample 排序并计算 quantiles、summary、bins、box、ECDF。
- normal scores、reference line 和 confidence band。
- MLE、optimizer、PDF/CDF/inverse CDF。
- GOF、tests、intervals 和 capability。
- 所有 chart-data coordinates。
- typed unavailable、failed、warnings 和 provenance。

不得：

- 在生产代码使用 `unwrap()` 或 `expect()`。
- 以 UI 格式化文本作为计算输入。
- 将 NaN/Infinity 发送到前端。

### 15.3 Typed IPC Contract

负责：

- versioned request/config/result。
- discriminated report blocks。
- calculation config 与 presentation preference 分离。
- stable reason codes。
- method、parameterization、optimizer 和 compatibility provenance。
- snapshot/run identity。

Rust models 使用 `#[serde(rename_all = "camelCase")]`，TS 类型必须镜像。

### 15.4 React Distribution Workspace

负责：

- 菜单、显示偏好、输入验证反馈和报告结构。
- 调用 store/service 发起新 revision。
- updating 时保留旧报告。
- payload-gated capability visibility。
- accessible controls、focus return、Escape close 和响应式布局。

不得：

- 计算统计量。
- 对 fit comparison 重新排序。
- 对 raw observations 排序或重新分箱。
- 根据自由文本 reason 判断状态。

### 15.5 Graph Builder / graphCore

负责：

- 将冻结 chart-data 映射为 ECharts series。
- axis、theme、legend、tooltip、zoom、pan、selection 和 export。
- responsive dimensions 和 nonblank rendering。

不得：

- 重算 quantiles、normal score、bins、whiskers、ECDF、PDF/CDF 或 capability。
- 用显示抽样改变统计结果。
- 让 count、tail count 或 metadata 污染 value axis extent。

## 16. Capability Registry 与菜单规则

菜单必须由 backend capability registry 与 payload 共同驱动：

- 未实现项不显示。
- deferred 项不显示。
- unavailable 项只有在功能真实存在、但当前数据不适用时显示 disabled 或 typed unavailable。
- 不使用点击后才提示“Coming soon”的空入口。
- 菜单显示名称由 i18n 提供，行为绑定 stable capability ID。

推荐菜单结构：

```text
Display
  Overview
  Quantiles
  Summary Statistics
  Horizontal Tables

Histogram
  Method
  Scale
  Fixed Count / Fixed Width parameters
  Specification Lines
  Outlier Box Plot

Diagnostic Plots
  Normal Quantile Plot
  Empirical CDF

Continuous Fit
  Fit Normal
  Fit Lognormal
  Fit Exponential
  Fit Gamma
  Fit Weibull
  Fit All

Process Capability
```

当 Stage 2 实现后，GOF 和模型诊断应放在对应 fit block 的菜单，而不是提升为 Y-level 的全局开关。

## 17. 持久化与迁移

必须保存：

- Histogram method 与 method parameters。
- Histogram scale 和各显示开关。
- diagnostics visibility。
- enabled fit models / Fit All 的候选快照。
- fit overlay/details visibility。
- confidence level 与未来 tests/interval parameters。
- capability 手工规格 override。

不得保存：

- 统计结果。
- chart coordinates。
- optimizer 中间状态。
- 临时 selection。
- 未验证的静态派生列副本。

项目打开后根据当前源数据重新计算。旧配置缺少新 presentation preference 时采用明确默认值；未知关键 calculation schema 不得静默降级。

## 18. 优化实施路线

### 18.1 Phase A：现有能力验收收口

目标：先把已实现能力从“自动 passing、UI pending”推进到产品可验收。

- 保持 Letter-Value Quantile Plot 与 Stem-and-leaf 为 removed，不恢复隐藏计算或菜单入口。
- 正式 Tauri UI 验收平台 Run/Edit/Save/Open 流程、Overview、Tukey Box、Quantiles、Summary、Horizontal Tables、ECDF 和 Normal Quantile。
- 验收 Count/Probability/Density scale 和 Fixed Count/Width。
- 验收 Normal/Lognormal/Exponential/Gamma/Weibull、Fit All 和 PDF overlay。
- 修复 weighted Continuous Fit：参数/PDF 保留，信息准则与 Fit All 排名返回 typed unavailable；增加 Weight 整体缩放测试。
- 验收 Normal Process Capability 与规格来源。
- 修正文档中与实际状态冲突的早期描述。
- 将失败项转成具体 bug/task，不以新功能掩盖现有验收缺口。

### 18.2 Phase B：Histogram 与 Display 交互优化

- 本阶段所有未在台账中批准的条目先完成 scope review；只有 `scopeStatus=approved` 且设计冻结后才能实现。
- 收拢 scale 为单一 segmented control。
- 明确 Automatic 的实际算法与 compatibility 状态。
- 增加 Show Counts / Show Percents presentation preferences，默认关闭。
- 评估 Vertical 方向切换是否有真实用户价值。
- 设计 Custom Quantiles 与 Customize Summary Statistics，但不同时扩展统计内核范围。

### 18.3 Phase C：Continuous Fit Stage 2

- 先为每个 GOF、诊断和新模型完成独立 method spec；Stage 2 设计本身不等于方法口径已冻结。
- 若要重新开放 weighted information criteria，先批准 normalized reliability likelihood method spec。
- Anderson-Darling。
- Normal 辅助 Shapiro-Wilk。
- 模型特定 Q-Q、fitted CDF、P-P。
- Pearson chi-square 的适用性门禁。
- 参数 SE/CI，仅在 Hessian 有效且模型可识别时输出。
- Cauchy 与 Student's t。

### 18.4 Phase D：连续推断

按独立 method spec 顺序：

1. Test Mean。
2. Test Std Dev。
3. Prediction Interval。
4. 重新评审 Equivalence。
5. 重新评审 Tolerance Interval。

### 18.5 Phase E：低优先级增强

仅在有明确用户需求和资源时评审：

- Save Columns。
- Fix Parameters。
- Profilers。
- Smooth Curve/KDE。
- SHASH、Johnson、mixtures。
- Shadowgram 等价分析体验。

## 19. 测试与验收矩阵

### 19.1 数值单元测试

每个 method 至少覆盖：

- empty、n=1、n=2。
- constant、ties、repeated values。
- symmetric、skewed、heavy-tail、outlier。
- negative、zero、extreme magnitude、near-zero variance。
- Missing、Filter、By Missing。
- Weight、Freq、Weight×Freq。
- invalid config、resource limit。
- deterministic output。

### 19.2 合同测试

- Rust/TS camelCase 镜像。
- report block discriminant 与 payload 同时存在。
- unavailable/failed 不携带伪造数值。
- 所有 available numeric fields finite。
- provenance 包含 method/version/snapshot/config revision。
- presentation preference 不增加 revision。
- calculation config 增加 revision 并触发 cancel/rerun。

### 19.3 Graph Builder 测试

- chart-data coordinates byte-for-byte 通过 adapter。
- graphCore 不导入统计 helper。
- Count/Probability/Density 三种 scale 非空。
- Normal Quantile、ECDF 和 PDF overlay 非空。
- desktop/mobile viewport 无重叠。
- 规格线在 extent 内。
- metadata 不污染 axis extent。
- fit PDF 只与 density axis 共用尺度。

### 19.4 项目与运行测试

- save/open 后显示偏好和 calculation config 恢复。
- registry 扩展不改变历史 Fit All candidate snapshot 的解释。
- source generation 改变时重算。
- stale run 被拒绝。
- 新 run 完成前旧报告保持可见。
- 单模型失败不清空其他 fit。

### 19.5 正式 UI 验收

必须在 Tauri 应用中人工完成：

- 菜单只显示真实能力。
- 键盘操作、Escape、focus return。
- 宽屏和窄屏布局。
- light/dark theme。
- 长表、长菜单和多 By group 滚动。
- 图例不侵入绘图区。
- reason code 有可理解的本地化文本。
- 保存并重开后的行为一致。

## 20. 完成定义

一个优化项只有同时满足以下条件才可标记完成：

1. scope 已批准。
2. 独立 method spec 或明确 presentation-only 设计已冻结。
3. Rust/TS 合同完成并版本化。
4. 数值或交互自动测试通过。
5. 前端 build 通过。
6. 涉及 Rust 时 cargo build/test 通过；clippy 基线阻塞需单独记录。
7. compatibility status 有证据支持。
8. 正式 Tauri UI 验收通过。
9. 批准范围与验收台账同步更新。

只完成代码、只通过测试、只生成截图或只获得产品口头确认，都不能单独满足完成定义。

## 21. 明确不做

- 不复制 JMP 菜单视觉、截图、文案、图标或帮助正文。
- 不从截图推断未公开统计公式。
- 不把相同功能名称当作数值兼容证据。
- 不在 React 或 graphCore 重算统计量。
- 不显示 deferred 或未实现能力的空入口。
- 不把 Mean CI、Prediction Interval、Tolerance Interval 和 Specification Limits 混为一类。
- 不把 GOF p-value、AIC 排名或 Q-Q 图单独解释为模型正确。
- 不物理展开大 Freq。
- 不序列化 NaN/Infinity。
- 不为匹配第三方外观而破坏 StatsPlayground 的架构边界。

## 22. 下一 session 执行入口

下一 session 不应直接开始大范围编码。建议使用以下输入顺序：

1. 阅读本手册和批准范围台账。
2. 读取与目标优化项对应的现有源码、测试和验收记录。
3. 明确本次只处理一个 phase 或一个可独立验收的 slice。
4. 为新统计方法先写 versioned method spec；纯 presentation 优化可直接形成短设计。
5. 建立 failing test 或明确现有人工验收失败点。
6. 做最小实现并执行 focused validation。
7. 完成 frontend build、相关 Rust tests 和 UI 验收。
8. 更新批准范围与验收台账。

推荐第一个后续任务不是新增统计功能，而是执行 **Phase A：现有能力正式 UI 验收与缺口收口**。只有在该阶段形成明确缺陷清单后，再决定进入 Histogram/Display 优化或 Continuous Fit Stage 2。

可直接用于下一 session 的任务描述：

> 依据 `docs/superpowers/specs/2026-08-31-distribution-optimization-handbook.md`，核对当前 registry、自动测试和正式 Tauri UI，输出逐项验收结果与缺陷清单；保持 Letter-Value Quantile Plot 与 Stem-and-leaf 为 removed，修复 P0 回归但不新增 P1/P2 功能。每个修复先建立可证伪检查，完成后运行 focused tests、frontend build 和相关 Rust tests，并同步批准范围与验收台账。
