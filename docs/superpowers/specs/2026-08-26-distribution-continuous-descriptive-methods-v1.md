# Distribution Continuous Descriptive Methods V1 Specification

**版本：** 1.0.0
**状态：** 产品与方法口径已批准，待实现验证与依赖审计
**覆盖 ID：** DESC-01、DESC-02、DESC-03、DESC-04、DESC-05、DESC-09
**依赖：** [Platform Workflow V1](2026-08-26-distribution-platform-workflow-v1.md)
**范围权威：** [批准范围与验收台账](2026-08-26-analysis-distribution-approved-scope.md)

## 1. 方法注册表

| method ID | version | 输出 |
| --- | --- | --- |
| `quantile.type6.weighted` | `1.0.0` | 批准概率点 quantiles |
| `summary.continuous.core` | `1.0.0` | Mean、Std Dev、Std Error、Mean CI、N、N Missing、Min、Max、Median、Mode、Range、IQR、MAD |
| `histogram.freedmanDiaconis` | `1.0.0` | count/probability/density bins |
| `boxplot.tukey.weighted` | `1.0.0` | quartiles、fences、whiskers、outliers、mean CI |
| `ecdf.weighted` | `1.0.0` | ECDF/CDF step coordinates |

未列出的摘要、检验、Q-Q/P-P、拟合和分类 method 不进入 registry。

## 2. 输入与观测贡献

对每个 Y、By group 独立计算。输入按 snapshot 中稳定 row order 获取：

- Y 缺失或非有限：从该 Y 的计算中排除，计入 `nMissing`。
- Weight 缺失或 0：排除该行；负值或非有限值：全局请求失败。
- Freq 缺失或 0：排除该行；负值、非整数或非有限值：全局请求失败。
- 无 Weight 时 `w_i = 1`；无 Freq 时 `f_i = 1`。
- 有效贡献 `c_i = w_i × f_i`。
- Weight 和 Freq 同时存在时按上述乘积合并，不物理展开数据。
- 缺失 By 作为独立 Missing group。

定义：

$$
W = \sum_i f_iw_i, \qquad W_2 = \sum_i f_iw_i^2, \qquad N_F = \sum_i f_i.
$$

`N` 报告 `N_F`（Freq 逻辑样本量；无 Freq 时为有效源行数），`Sum Weight` 不在首版报告中但 provenance 记录 `W`。Kish 有效样本量：

$$
n_{eff}=\frac{W^2}{W_2}.
$$

若 `W <= 0`、`N_F <= 0` 或 `n_eff < 1`，对应 group/Y 为 unavailable。

## 3. 排序与确定性

- 数值按 IEEE total order 的有限子集升序；`-0` 归一为 `0`。
- 并列值按 source row ID 稳定排序。
- 所有聚合使用固定遍历顺序和补偿求和（Neumaier 或等价确定性算法）。
- 跨平台黄金比较同时定义 absolute、relative 和 ULP 容差；离散计数、bin membership、N、Mode ties 必须精确相等。

## 4. Weighted Type-6 Quantile

### 4.1 等效样本缩放

按 Y 排序后，对每个有效源行定义缩放质量：

$$
a_i = c_i\frac{N_F}{W}, \qquad A_i=\sum_{j=1}^{i}a_j.
$$

因此 $A_m=N_F$；当 Weight 全为 1 时，Freq 与逻辑展开完全等价。Weight 整体乘常数不改变结果。

### 4.2 分位数

对概率 $p\in[0,1]$：

1. $p=0$ 返回最小值，$p=1$ 返回最大值。
2. 计算 $h=(N_F+1)p$，并截断到 $[1,N_F]$。
3. 定义 knots：`(max(1, A_i), x_i)`；相同 knot position 保留排序后最后一个值；首 knot position 大于 1 时补 `(1,x_1)`。
4. 若 $h$ 落在 knots $(r_j,x_j)$ 与 $(r_{j+1},x_{j+1})$ 之间：

$$
Q(p)=x_j+\frac{h-r_j}{r_{j+1}-r_j}(x_{j+1}-x_j).
$$

5. $h$ 超出 knots 时返回最近端点。

累计位置使用 IEEE-754 f64，不预先舍入。比较 $h$ 与 knot 时使用：

$$
\epsilon_r=8\epsilon_{machine}\max(1,|h|,|r_j|).
$$

若 $|h-r_j|\le\epsilon_r$，视为精确命中并返回 $x_j$；若相邻累计位置差不大于 $\epsilon_r$，合并为同一 knot 并保留排序后最后一个值。插值比例只在分母大于 $\epsilon_r$ 时计算，并截断到 `[0,1]`。Golden matrix 必须覆盖接近 knot、极小 Weight、Weight 整体缩放和并列累计位置。

批准概率点：`0, 0.005, 0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975, 0.995, 1`。内部 median/Q1/Q3 复用同一函数。

## 5. Core Summary

加权均值：

$$
\bar{x}=\frac{\sum_i f_iw_ix_i}{W}.
$$

无偏 reliability/frequency 混合方差分母：

$$
D=W-\frac{W_2}{W}, \qquad s^2=\frac{\sum_i f_iw_i(x_i-\bar{x})^2}{D}.
$$

`D <= 0` 时 Std Dev、Std Error、Mean CI unavailable。Std Error：

$$SE=s/\sqrt{n_{eff}}.$$

Mean CI 使用分析级 `confidenceLevel` 和 Student-t，自由度 $\nu=n_{eff}-1$：

$$\bar{x}\pm t_{1-\alpha/2,\nu}SE.$$

Mean CI 仅在 `D > 0`、`n_eff > 1`、自由度和 t quantile 均有限时 available；否则返回 typed unavailable，reason `summary.meanCiUnavailable.v1`。当 `1 < n_eff < 2` 时允许非整数正自由度，由锁定版本的 Student-t 实现计算。

Minimum/Maximum/Range 使用有效观测；Median/IQR 使用 weighted Type-6。MAD 定义为对 $|x_i-Q(0.5)|$ 使用同一 weighted Type-6 的 0.5 quantile，不乘 normal consistency factor。

Mode 按每个唯一值累计 $c_i$；返回全部最大质量 ties，数值升序。报告首值为 `primaryMode`，同时返回 `modes[]`，禁止依赖输入顺序选 tie。

## 6. Histogram Freedman-Diaconis

使用 weighted IQR 与 $n_{eff}$：

$$h_{FD}=2\,IQR\,n_{eff}^{-1/3}.$$

回退链：

1. 若 $h_{FD}$ 有限且大于 0，使用 FD。
2. 否则若 $s>0$，使用 Scott：$h=3.5s\,n_{eff}^{-1/3}$。
3. 否则若 `min < max`，Sturges 箱数 $k=\max(1,\lceil\log_2(n_{eff})+1\rceil)$，$h=(max-min)/k$。
4. 常数列生成一个 bin，中心为常数，宽度使用 `max(abs(x),1) × 1e-6`。

有限非零宽度下：

- `origin = floor(min / h) × h`。
- `end = ceil(max / h) × h`；若 end == max，保留该端点。
- bins 为 `[lower,upper)`，最后一箱右闭。
- `count = Σc_i`。
- `probability = count/W`。
- `density = count/(W×binWidth)`。
- 必须输出空 bin；bin 边界与 membership 是 Distribution 结果，Graph Builder 不重新分箱。

用户显式 bin width/count 属后续可配置项，本规格首版只冻结默认行为。

## 7. Tukey Box

- Q1/Median/Q3 使用 weighted Type-6。
- `IQR = Q3-Q1`；fences 为 `Q1-1.5 IQR` 与 `Q3+1.5 IQR`。
- whisker 是 fences 内最小/最大有效观测值；fence 本身不是 whisker。
- 每个唯一 outlier 输出 `{value, contribution, sourceRowCount}`，不按 Freq 物理重复。
- IQR=0 时，所有不等于 median 的值按相同 fence 规则成为 outlier；常数列 whiskers 与 quartiles 均等于常数。
- Box mean interval 使用第 5 节 Mean CI；不可用时字段为 null 并携带 reason code。

## 8. Weighted ECDF/CDF

按唯一值聚合 contribution。对升序唯一值 $v_j$：

$$F(v_j)=\frac{\sum_{x_i\le v_j}c_i}{W}.$$

输出 step coordinates 包含起点 `{x=min, probability=0}`、每个唯一值的跳变前/后坐标和终点概率 1。payload 保留每个 jump 的 contribution；Graph Builder 使用 step-after 渲染，不插值、不平滑。

## 9. 报告合同

每个 By/Y 返回：

- typed group key 与 Y column ref；
- eligibility summary：source rows、N、N Missing、excluded Weight/Freq rows、W、nEff；
- quantile table；core summary table；
- histogram、box、ECDF chart-data blocks；
- block status：available、partial、unavailable；
- method IDs/versions、snapshot/schema/filter/parameter hashes。

Histograms Only 只抑制统计表和非 histogram 图，不改变数据预处理或 histogram 数值。

## 10. 资源与失败状态

- 超过 maxGroups、maxRowsPerGroup、maxTotalRows、maxTotalBytes 时全局失败，不自动 approximate。
- empty group：所有 blocks unavailable。
- 单有效观测：mean/min/max/median/mode 可用；variance/SE/CI unavailable；histogram/box/ECDF 按定义输出。
- constant column：descriptive blocks 可用，variance=0；Mean CI 退化为 `[mean,mean]` 仅当 D>0；histogram 使用常数回退。
- 非法 Weight/Freq：全局 InvalidParam，稳定 code 和 field path。

## 11. 黄金矩阵与容差

必须覆盖：空、n=1/2、常数、重复、ties、偏态、重尾、多峰、零膨胀、缺失、Weight、Freq、Weight×Freq、By Missing、Filter、极端量级、近零方差、p=0/1。

- 整数/枚举/bin membership/Mode ties：精确。
- 基础 double：`abs <= 1e-12` 或 `rel <= 1e-10`，取先满足者。
- t quantile/CI：`abs <= 1e-10` 或 `rel <= 1e-9`。
- chart coordinates：数值遵循其来源 method 容差，不允许像素截图代替数值验收。

## 12. 公开算法来源类别

实现规格基于公开统计定义：Hyndman-Fan quantile 分类、Freedman-Diaconis histogram rule、Scott rule、Tukey box plot、weighted ECDF、Student-t interval。实际实现计划必须记录所用 Rust crate 的许可证和版本；不得把任何第三方产品输出或帮助文本作为实现资料。

## 13. 明确不做

DESC-06/07/08/10、所有 TEST、通用分布拟合、Normal Capability、分类/多重响应、派生列均不属于本规格。
