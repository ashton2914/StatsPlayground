# Distribution JMP术语与方法对齐设计

**日期：** 2026-08-31
**状态：** 已批准
**目标：** 以JMP Pro 19可观察术语和输出结构为产品基准，同时对未公开算法保持可审计兼容状态

**依赖：**

- [Distribution优化设计手册](2026-08-31-distribution-optimization-handbook.md)
- [Phase A布局与Capability区间设计](2026-08-31-distribution-phase-a-layout-capability-design.md)
- [Continuous Fit设计](2026-08-28-distribution-continuous-fit-jmp19-design.md)
- [Visual Diagnostics设计](2026-08-27-distribution-visual-diagnostics-jmp19-design.md)

## 1. 原则

1. Distribution可见统计术语优先采用JMP 19中通用、事实性的专业名称。
2. 不复制JMP帮助正文、界面视觉、代码、图标或资产。
3. 术语相同不代表算法相同；每个方法继续携带method/provenance/compatibility status。
4. 已确认的公式或参数计数错误立即修复。
5. 未公开的JMP算法必须新增版本化方法和脱敏fixture，不得静默改写现有`intentionalDifference`方法。
6. Rust拥有统计计算；React只格式化和展示；graphCore只映射冻结坐标。

## 2. 三阶段范围

### Stage 1：术语、显示和已确认错误

- `Std Error`改名为`Std Error Mean`，计算保持$s/\sqrt{n_{eff}}$。
- Summary保留Median、N Missing、Range、IQR、MAD。
- Mode在所有值同频或最高频并列时显示`No unique mode`，不再错误显示最小值为唯一众数。
- MAD明确为raw MAD，不乘1.4826；可见术语使用`MAD`并在方法状态中保留定义。
- Process Summary新增Stability Index：

$$
Stability\ Index=\frac{Overall\ Sigma}{Within\ Sigma}.
$$

- Capability index/interval固定显示3位小数，payload不舍入。
- Nonconformance默认使用JMP结构：`Portion | Observed % | Expected Within % | Expected Overall %`。
- Exponential固定location不计入自由参数数，$k=1$。
- Continuous Fit Measures默认显示`-2*LogLikelihood`、`AICc`、`BIC`；AIC保留payload但不作为默认表行。
- 模型术语改为JMP结构：Normal使用Location/Dispersion；Lognormal说明natural-log scale；Gamma/Weibull使用Shape/Scale；固定参数显示`Fixed`。

Stage 1当时未新增参数SE/CI；后续批准的 Fit Inference 设计已交付五模型固定95%参数推断，且不改变point estimate方法。

### Stage 2：Continuous Fit JMP目标合同

- 51行missing-region样本新增五模型JMP observed fixture。
- 参数合同增加`estimate`、`standardError`、`lowerConfidence`、`upperConfidence`、`fixed`。
- 增加`estimatedParameterCount`，信息准则只计算自由估计参数。
- Normal新增JMP目标估计方法；当前MLE方法保留版本，避免静默改变旧项目。
- Gamma/Weibull参数SE/CI使用冻结的observed/expected information方法。
- 固定location、threshold、参数顺序、natural-log约定、AICc/BIC公式和Weight语义写入provenance。
- 在多组fixture通过前保持`compatibilityPending`。

### Stage 3：JMP特定图形和区间方法

- 新增`quantileBox.jmp19.v1`；现有letter-value方法保留为`intentionalDifference`。
- 新增`stemLeaf.jmp19.v1`；现有decimal方法保留为`intentionalDifference`。
- 新方法必须冻结scale、rounding、negative/zero、split stems、Count、解释key和omission规则。
- Capability exact interval另建非中心$t$/Cpk method spec和多样本fixture。
- 单张截图不得作为validated compatibility的充分证据。

## 3. Summary Statistics决策

| 字段 | 定义 | Stage 1决策 |
| --- | --- | --- |
| Median | weighted Type-6的50%分位数 | 保留 |
| N Missing | Filter/By后Y为missing或非finite的源行数 | 保留 |
| Mode | contribution最高的值集合 | 并列时显示No unique mode |
| Range | Maximum-Minimum | 保留 |
| IQR | Q3-Q1 | 保留 |
| MAD | median of absolute deviations from median | 保留，raw MAD |
| Std Error Mean | sample Std Dev/$\sqrt{n_{eff}}$ | 重命名，公式不变 |

`DistributionSummaryDataV1`在Stage 1增加mode状态或完整modes，以区分unique mode和ties。不得从`primaryMode`单值推断唯一众数。

## 4. Process Capability决策

### 4.1 Stability Index

- 当Within Sigma与Overall Sigma均available、finite且Within Sigma$>0$时返回ratio。
- Within Sigma为0时返回typed unbounded或unavailable，不能序列化Infinity。
- 任一Sigma unavailable时返回相同语义的typed unavailable。
- method ID：`capability.stability.overallToWithin.v1`。
- 当前51行样本expected=`1.218682`。

### 4.2 数字格式

- Cp/Cpk/Cpl/Cpu/Cpm/Pp/Ppk/Ppl/Ppu和区间：固定3位小数。
- Observed/Expected百分比：最多4位小数，保留必要尾数。
- N/Count：整数。
- Mean/Sigma/MR：最多8位有效数字。
- 后端数值不因显示要求舍入。

### 4.3 Nonconformance

默认四列：

```text
Portion | Observed % | Expected Within % | Expected Overall %
```

使用现有payload的`proportion*100`。Observed Count、PPM和Wilson interval保留在typed payload，可在未来详细视图使用，但不进入默认表。

### 4.4 Interval状态

Phase A公开effective-DF方法继续使用；51行差异保持记录：

- Cpl public约`[-0.377443,-0.151343]`，JMP约`[-0.376,-0.150]`。
- Cpu public约`[1.017419,1.731871]`，JMP约`[1.021,1.726]`。

Stage 1只应用3位小数显示，不改区间数学，不声称exact compatibility。

## 5. Continuous Fit Stage 1修正

### 5.1 参数计数

每个参数增加`fixed`语义或模型返回独立`estimatedParameterCount`。Stage 1最小要求：

| 模型 | 自由参数数$k$ |
| --- | ---: |
| Normal | 2 |
| Lognormal | 2 |
| Exponential location0 | 1 |
| Gamma shape/scale location0 | 2 |
| Weibull shape/scale location0 | 2 |

Exponential不再用`parameters.len()`得到$k=2$。

对51行样本，修正后Exponential应为：

- $-2\ell=740.6183972$
- AICc=`742.7000298`
- BIC=`744.5502228`

### 5.2 Measures术语

默认表显示：

$$
-2LogLikelihood=-2\ell.
$$

AICc与BIC沿现有typed values显示。AIC继续保留contract供诊断和排序fallback，不在默认JMP风格表中显示。

### 5.3 参数术语

- Normal：Location、Dispersion。
- Lognormal：Scale $\mu$、Shape $\sigma$，并显示natural-log parameterization说明。
- Exponential：Scale；Location=0显示Fixed。
- Gamma：Shape、Scale；Location=0显示Fixed。
- Weibull：Shape、Scale；Location=0显示Fixed。

Stage 1只对齐可见术语，不伪造Std Error或Confidence Limits。

## 6. Quantile Box与Stem-and-Leaf（历史状态）

### 6.1 当前状态

- `quantileBox.public.letterValue.type6.v1`是自有letter-value方法，`intentionalDifference`。
- `stemLeaf.public.decimal.v1`是自有decimal heuristic，`intentionalDifference`。
- 当前JMP fixture只含missing-evidence marker，不能支持算法替换。

### 6.2 Stage 1处理

- 保留当前实现和兼容标签。
- Quantile Box可见名称增加`Letter-Value`说明，避免暗示JMP等价。
- Stem报告补Count列、leaf-unit/解释key，并优先修复$(-scale,0)$符号表达缺陷。
- 不改变现有method ID的数学结果，除非是明确的数据表达bug；bugfix必须有版本/provenance说明。

后续产品决策已覆盖本节：Letter-Value Quantile Plot 与 Stem-and-Leaf 已彻底移除，以上内容仅记录 Stage 1 历史状态，不再代表当前 runtime 或未来路线。

### 6.3 Stage 3准入

JMP目标实现至少需要脱敏case覆盖：n=1..20、ties、outliers、负数近零、decimal boundaries、split stems、extreme scale、Freq。Weight若JMP语义不可验证则保持unavailable。

## 7. 术语映射

Stage 1统一以下英文：

- Summary Statistics
- Std Error Mean
- Process Summary
- Stability Index
- Within Sigma Capability
- Overall Sigma Capability
- Lower 95% / Upper 95%
- Nonconformance
- Portion
- Observed %
- Expected Within %
- Expected Overall %
- Parameter Estimates
- Estimate
- Measures
- -2*LogLikelihood
- AICc
- BIC
- Fixed

中文和越南文翻译保持统计意义，不逐字复制JMP帮助文本。

## 8. 验收与兼容性

- Stage 1必须使用51行tracked fixture验证Summary、Stability、Nonconformance和Exponential信息准则。
- UI screenshot仅验证术语和布局，不能升级数值兼容状态。
- Quantile Box、Stem、Continuous Fit与Capability exact intervals继续保持现有兼容状态。
- 所有available numeric fields必须finite。
- 完整门禁：frontend tests、build、Rust tests、四语言parse、diff check、Tauri smoke。

## 9. 非目标

- Stage 1不实现参数SE/CI。
- Stage 1不把Normal MLE改成JMP dispersion方法。
- Stage 1不实现JMP Quantile Box/Stem算法。
- Stage 1不实现Stability control-chart诊断；仅实现已冻结的Overall/Within ratio。
- 不通过显示舍入掩盖统计方法差异。
