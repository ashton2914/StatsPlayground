# Distribution 可视化诊断与 JMP 19 数值兼容设计

**日期：** 2026-08-27
**状态：** 已批准
**阶段：** Visual Diagnostics V1
**依赖：**
- [Continuous Descriptive Methods V1](2026-08-26-distribution-continuous-descriptive-methods-v1.md)
- [Distribution 正式报告设计](2026-08-27-distribution-formal-report-design.md)
- [批准范围与验收台账](2026-08-26-analysis-distribution-approved-scope.md)

## 1. 目标

在不复制第三方界面、代码或帮助正文的前提下，为连续 Y 增加完整的可视化与显示控制，并以 JMP 19 为数值兼容目标：

1. 修复 Overview 的规格线、异常轴标签和 Process Capability 图形坐标问题。
2. 提供 Display、Histogram、Diagnostic Plots 与 Process Capability 分组菜单。
3. 增加 Normal Quantile Plot、Quantile Box Plot、Stem and Leaf。
4. 扩展 Histogram bin method 与 scale。
5. 将 Quantiles 与 Summary Statistics 横向排列并增强表格分隔。
6. 将 Nonconformance 压缩为三行核心结果。

本阶段不包含 hypothesis tests、prediction/tolerance intervals、distribution fitting 或派生列保存。

## 2. 兼容性原则

### 2.1 状态

每项方法必须具有以下兼容状态之一：

- `documentedCompatible`：公开公式与 JMP 19 官方文档一致，并通过数值矩阵。
- `validatedCompatible`：公开文档未给出完整算法，但脱敏黑盒矩阵通过。
- `compatibilityPending`：功能可用，但尚无足够证据声明 JMP 19 数值兼容。
- `intentionalDifference`：产品明确选择不同方法，UI 与 provenance 必须说明。

不得仅因菜单名称、图形外观或公开方法类别相同而声明兼容。

### 2.2 验收容差

- 状态、行数、bin 数、bin 边界、stem/leaf 文本和省略计数：精确相等。
- 普通浮点：`abs <= 1e-10` 或 `rel <= 1e-9`。
- 极端 Normal tails：使用相对误差或 ULP 容差，并记录比较规则。
- UI 布局、颜色、菜单样式不属于数值兼容范围。

### 2.3 证据边界

- 官方帮助只用于公开公式、参数含义与行为说明。
- 黑盒 fixture 只保存脱敏 synthetic inputs、机器数值输出、版本和 hash。
- 不保存第三方截图、帮助正文、项目文件或自由文本输出。
- 未通过证据门禁的方法可以开发，但只能标记 `compatibilityPending`。

## 3. 配置与计算边界

### 3.1 计算配置

以下字段改变统计结果，更新 `configRevision` 并重新运行：

```ts
interface DistributionVisualDiagnosticsConfigV1 {
  histogram: {
    method: "jmpAuto" | "freedmanDiaconis" | "scott" | "sturges" | "fixedCount" | "fixedWidth";
    fixedCount: number | null;
    fixedWidth: number | null;
  };
  normalQuantileConfidenceLevel: number;
}
```

- `fixedCount` 仅在 method 为 `fixedCount` 时使用，范围 `1..1000`。
- `fixedWidth` 仅在 method 为 `fixedWidth` 时使用，必须 finite 且 `>0`。
- `jmpAuto` 只有在黑盒 bin 矩阵通过后才能标记 compatible。
- 其他命名方法按公开公式实现，不借用 JMP compatible 状态。

### 3.2 显示偏好

以下字段立即生效、随项目保存，但不更新统计 revision：

```ts
interface DistributionYReportPreferencesV2 {
  overview: boolean;
  histogram: boolean;
  outlierBoxPlot: boolean;
  specificationLines: boolean;
  quantiles: boolean;
  summary: boolean;
  horizontalTables: boolean;
  normalQuantilePlot: boolean;
  quantileBoxPlot: boolean;
  stemAndLeaf: boolean;
  ecdf: boolean;
  processCapability: boolean;
  histogramScale: "count" | "probability" | "density";
}
```

默认开启 Overview、Histogram、Outlier Box Plot、规格线、Quantiles、Summary、横向表格与 Process Capability；Normal Quantile Plot、Quantile Box Plot、Stem and Leaf、ECDF 默认关闭。

## 4. 后端预计算

同一次 Y/group run 预计算全部已批准 block。React 不排序样本、不 re-bin、不计算 quantile、normal score、density 或 stem。

统一合同：

```ts
type Jmp19CompatibilityStatus =
  | "documentedCompatible"
  | "validatedCompatible"
  | "compatibilityPending"
  | "intentionalDifference";

interface DiagnosticProvenanceV1 {
  methodId: string;
  methodVersion: string;
  snapshotId: string;
  compatibilityStatus: Jmp19CompatibilityStatus;
}

interface NormalQuantilePointV1 {
  rank: number;
  probability: number;
  normalScore: number;
  observedValue: number;
}

interface NormalQuantileDataV1 {
  points: NormalQuantilePointV1[];
  referenceLine: Array<{ x: number; y: number }>;
  confidenceBand: Array<{ x: number; lower: number; upper: number }>;
  status: "available" | "unavailable" | "failed";
  reasonCode: string | null;
  provenance: DiagnosticProvenanceV1;
}

interface QuantileBoxLayerV1 {
  probabilityLower: number;
  probabilityUpper: number;
  lower: number;
  upper: number;
  depth: number;
}

interface QuantileBoxDataV1 {
  layers: QuantileBoxLayerV1[];
  median: number;
  status: "available" | "unavailable" | "failed";
  reasonCode: string | null;
  provenance: DiagnosticProvenanceV1;
}

interface StemAndLeafRowV1 {
  stem: string;
  leaves: string[];
  omittedLeafCount: number;
}

interface StemAndLeafDataV1 {
  rows: StemAndLeafRowV1[];
  scale: number;
  omittedStemCount: number;
  omittedLeafCount: number;
  status: "available" | "unavailable" | "failed";
  reasonCode: string | null;
  provenance: DiagnosticProvenanceV1;
}
```

### 4.1 Normal Quantile Plot

JMP 19 官方统计细节给出的 empirical cumulative probability 为：

$$
p_i=\frac{r_i}{N+1},
$$

normal score 为：

$$
z_i=\Phi^{-1}\left(\frac{r_i}{N+1}\right).
$$

- $r_i$ 为第 $i$ 个非缺失、非排除观测的 rank，$N$ 为有效观测数。
- ties 使用 JMP 19 行为矩阵确定 rank 规则；证据完成前状态为 `compatibilityPending`。
- Freq 使用逻辑重复样本，但实现不得展开到无界数组。
- Weight 返回 `unavailable`，reason `normalQuantile.weightUnsupported.v1`。
- 参考线和 95% pointwise band 必须单独记录 method ID。JMP band 公式未被当前公开页完整说明，因此通过黑盒矩阵前不得标记 compatible。
- 输出最多 2,000 个绘图点；大样本使用确定性 rank grid，必须保留两端、中心和规格限邻域。

### 4.2 Histogram

支持 `jmpAuto`、Freedman-Diaconis、Scott、Sturges、Fixed count 与 Fixed width。

- bin lower/upper、count、probability、density 全部由 Rust 输出。
- Count 使用总 contribution；Probability 为 contribution/W；Density 为 probability/bin width。
- 非 `jmpAuto` 方法使用公开公式和独立 method ID。
- `jmpAuto` 的 width、anchor、边界闭合、退化列和极端范围行为由黑盒矩阵冻结。
- Histogram scale 只选择后端已输出的 count/probability/density，不触发 re-bin。

### 4.3 Quantile Box Plot

- 目标是 JMP 19 Quantile Box Plot 数值兼容，不再预设 letter-value plot。
- 黑盒 fixture 必须覆盖 $n=1..20$、奇偶样本、ties、outliers、负数、小数、Freq 与 Weight。
- 合同输出有序层：`probabilityLower/probabilityUpper/lower/upper/depth`。
- 在层级规则通过矩阵前，block 状态为 `compatibilityPending`，报告标题显示兼容状态。

### 4.4 Stem and Leaf

- 后端基于全部有效数据精确计算，不抽样。
- 黑盒矩阵冻结 decimal scale、split stems、负数、零、舍入和重复值顺序。
- Freq 等价逻辑重复；Weight 返回 `unavailable`。
- 默认显示最多 200 stems、每 stem 最多 120 leaves，并输出 `omittedStemCount`、`omittedLeafCount`。
- 完整展开受 `maxTotalRows` 与 `maxTotalBytes` 保护。

### 4.5 CDF

继续使用后端 frozen ECDF coordinates。JMP 兼容矩阵覆盖 ties、Freq、Weight、单点和末点恰为 1。

## 5. Overview 与 Capability 图修复

### 5.1 Overview

- 从同一 Y 的 Process Capability payload 获取 LSL、Target、USL。
- 规格线同时显示在 Histogram 与 Box Plot 的共享 value axis 上。
- value extent 覆盖 bins、whiskers、outliers 与规格线。
- count axis 显式固定为 `[0,max(displayed bin metric)]`。
- custom series tuple 的非坐标字段不得参与 ECharts extent；不得声明 custom `encode`。
- 修复异常标签 `17445714`，测试必须使用高 count 与大 outlier 的分离 fixture 证明两个轴没有交叉污染。

### 5.2 Process Capability

- Histogram density、Overall density、Within density 共用 X=value、Y=density。
- LSL、Target、USL 使用独立线型与标签。
- tail counts 仅决定 bin style，不参与坐标 extent。
- 图形只消费后端 chart-data，不重新计算 density。

## 6. 报告布局

- Quantiles 与 Summary Statistics 默认放在同一 `.distribution-table-pair` 中左右排列。
- 小于 `900px` 或关闭 `horizontalTables` 时改为纵向。
- 表格显示外边框、表头底边、行分隔和列分隔；数值右对齐。
- 不使用嵌套 card。

Nonconformance 默认压缩为：

| Region | Observed Count | Observed PPM | Expected Within PPM | Expected Overall PPM |
| --- | ---: | ---: | ---: | ---: |
| Below LSL | | | | |
| Above USL | | | | |
| Total Outside | | | | |

Wilson interval 与 proportion 保留在后端合同中，但不在默认表格展开。

## 7. 菜单

Y 菜单采用 StatsPlayground 自有分组：

- Display：Overview、Quantiles、Summary Statistics、Horizontal Tables。
- Histogram：method、scale、Specification Lines、Outlier Box Plot。
- Diagnostic Plots：Normal Quantile Plot、Quantile Box Plot、Stem and Leaf、Empirical CDF。
- Process Capability。

只有具备真实 backend contract 的项目才能进入菜单。Test、Fit、Save 与其他 deferred 项不得显示空入口。

## 8. 验收矩阵

自动验收至少覆盖：

1. JMP documented normal scores，含 ranks、ties、$N=1/2/3$ 和 Freq。
2. 每种 Histogram method 的边界、归一化、常数列和 invalid config。
3. `jmpAuto` synthetic black-box fixture 的 exact bins。
4. Quantile Box Plot 与 Stem and Leaf 黑盒矩阵及 compatibility status。
5. Overview 无异常 count 标签，规格线在共享 value extent 内。
6. Capability density 轴与规格线正确，tail counts 不污染 extent。
7. Quantiles/Summary 双栏、窄屏单栏与表格线。
8. Nonconformance 恰为三行核心结果。
9. 显示偏好 save/open 保持且不增加 config revision。
10. Weight/Freq、By、Missing、Filter 与资源预算。

正式 UI 验收必须在 Tauri 应用中执行；自动测试不得把 `uiAcceptance` 标为 passed。