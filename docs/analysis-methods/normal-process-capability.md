# Normal Process Capability 计算逻辑

**分析入口：** Distribution → Process Capability
**方法 ID：** `capability.normal.individuals`
**默认方法版本：** `1.1.0`
**Nested Subgroup 方法版本：** `2.0.0`
**状态：** Individuals / Moving Range、Nested Subgroup 与 Count Histogram 已实现

## 1. 适用范围

该方法适用于连续响应变量 $Y$，并假设过程输出服从正态分布。至少需要一个有效规格限：下规格限 $LSL$ 或上规格限 $USL$。Target 单独存在时不启用 Process Capability。

默认方法使用 Individuals / Moving Range，移动极差窗口固定为 2。Weight 和 Frequency 当前不参与 capability 计算；配置任一角色时，Distribution 的其他描述统计仍可运行，但 Capability 返回 unavailable。

Nested Subgroup 是兼容扩展：未选择标签列时保留原算法、结果和 provenance；选择标签列时，只改变 Within Sigma 的估计边界，不改变 By 分组、Overall Sigma、直方图观测值或 observed nonconformance。

## 2. 规格限

当前产品入口只使用 Table 响应列属性中的规格限：

- Analysis 运行 snapshot 读取响应列的 `lsl`、`target` 和 `usl`。
- Distribution Analysis 不提供独立的规格编辑器，也不在 Analysis 定义中持久化另一套规格限。
- 旧项目中残留的 `specLimits` 会在迁移时规范化为空；底层 `capabilityOverrides` payload 仅为兼容合同，不是当前产品入口的规格来源。
- 所有提供的数值必须有限。
- 双侧规格必须满足 $LSL<USL$。
- Target 必须位于已提供的规格边界内。
- 无效列属性产生 warning，并且不生成 Capability block。

## 3. 有效观测、By 与顺序

Capability 继承 Distribution 的 Filter 和 By eligibility。响应缺失的行不进入计算。对每个响应变量和每个 By group 独立计算报告；By 未配置时，全部有效观测构成一个 Overall report group。

Individuals 方法必须按过滤后稳定的 source `_row_id` 升序处理观测，不按响应值排序。顺序改变会改变 Moving Range 和 Within Sigma，但不会改变均值或 Overall Sigma。

设当前 By group 的有效观测按 source row order 为 $x_1,\ldots,x_n$。

## 4. Process Summary

均值：

$$
\bar{x}=\frac{1}{n}\sum_{i=1}^{n}x_i.
$$

Overall Sigma 使用无偏样本标准差：

$$
s_{overall}=\sqrt{\frac{\sum_{i=1}^{n}(x_i-\bar{x})^2}{n-1}}.
$$

### 4.1 默认 Individuals / Moving Range

未配置 Nested Subgroup 时，相邻 source rows 形成窗口为 2 的移动极差：

$$
MR_i=|x_i-x_{i-1}|,\qquad i=2,\ldots,n.
$$

$$
\overline{MR}=\frac{1}{n-1}\sum_{i=2}^{n}MR_i.
$$

对两个独立正态观测的绝对差：

$$
d_2(2)=\frac{2}{\sqrt{\pi}}.
$$

Within Sigma 为：

$$
s_{within}=\frac{\overline{MR}}{d_2(2)}.
$$

### 4.2 Nested Subgroup

用户可以选择一个包含 subgroup label 的分类列。标签从属于当前 By group，不加入 By report key，也不为每个标签创建独立报告。

同一 By group 内，所有相同、非缺失标签的观测构成一个 rational subgroup，即使这些行在原表中不连续。每个 subgroup 内仍按 `_row_id` 升序排列。设第 $j$ 个 subgroup 有 $n_j$ 个有效观测 $x_{j,1},\ldots,x_{j,n_j}$。

只在同一 subgroup 内计算相邻 Moving Range：

$$
MR_{j,i}=|x_{j,i}-x_{j,i-1}|,
\qquad i=2,\ldots,n_j.
$$

有效 Moving Range 对数为：

$$
M=\sum_j\max(n_j-1,0).
$$

所有有效 pair 使用相同权重进行 pooling：

$$
\overline{MR}_{nested}
=\frac{1}{M}\sum_j\sum_{i=2}^{n_j}MR_{j,i}.
$$

$$
s_{within,nested}
=\frac{\overline{MR}_{nested}}{d_2(2)}.
$$

不同标签之间不形成 Moving Range。未配置 Nested Subgroup 时，全部观测等价于一个长度为 $n$ 的 subgroup，因此该扩展严格退化为默认算法。

Nested Subgroup 不切换为 Xbar/R、Xbar/S 或 pooled within-subgroup sample standard deviation；它保留 MR(2) estimator，只定义合理的相邻关系。

## 5. Capability Indices

双侧 Within capability：

$$
Cp=\frac{USL-LSL}{6s_{within}},
$$

$$
Cpl=\frac{\bar{x}-LSL}{3s_{within}},\qquad
Cpu=\frac{USL-\bar{x}}{3s_{within}},
$$

$$
Cpk=\min(Cpl,Cpu).
$$

双侧 Overall performance：

$$
Pp=\frac{USL-LSL}{6s_{overall}},
$$

$$
Ppl=\frac{\bar{x}-LSL}{3s_{overall}},\qquad
Ppu=\frac{USL-\bar{x}}{3s_{overall}},
$$

$$
Ppk=\min(Ppl,Ppu).
$$

当 Target $T$ 和双侧规格均存在时：

$$
Cpm_{within}
=\frac{USL-LSL}{6\sqrt{s_{within}^2+(\bar{x}-T)^2}},
$$

$$
Cpm_{overall}
=\frac{USL-LSL}{6\sqrt{s_{overall}^2+(\bar{x}-T)^2}}.
$$

单侧规格只输出对应的 $Cpl/Ppl$ 或 $Cpu/Ppu$；需要双侧规格的指标为 notApplicable。指标允许为负值，表示过程均值位于规格限外，不截断为 0。

Nested Subgroup 配置后，$Cp$、$Cpl$、$Cpu$、$Cpk$、$Cpm_{within}$ 及 Expected Within 使用 $s_{within,nested}$。Overall 系列保持不变。

## 6. 置信区间与有效自由度

令置信水平为 $1-\alpha$。定义：

$$
v=2\left(1-\frac{2}{\pi}\right),
$$

$$
c=\frac{1}{3}+\frac{2\sqrt{3}-4}{\pi}.
$$

默认路径令 $m=n-1$：

$$
r_{MR}=\frac{mv+2(m-1)c}{m^2d_2^2},
\qquad
\nu_{MR}=\frac{1}{2r_{MR}}.
$$

Nested Subgroup 中，只有同一 subgroup 内连续的两个 Moving Range 才共享一个观测。定义：

$$
A=\sum_j\max(n_j-2,0).
$$

$$
r_{nested}
=\frac{Mv+2Ac}{M^2d_2^2},
\qquad
\nu_{nested}=\frac{1}{2r_{nested}}.
$$

当只有一个长度为 $n$ 的 subgroup 时，$M=n-1$ 且 $A=n-2$，与默认公式完全相同。

Within $Cp$ 使用 effective DF 的 chi-square approximation：

$$
Cp_L=Cp\sqrt{\frac{\chi^2_{\alpha/2,\nu}}{\nu}},
\qquad
Cp_U=Cp\sqrt{\frac{\chi^2_{1-\alpha/2,\nu}}{\nu}}.
$$

Within 单侧 index $C\in\{Cpl,Cpu\}$ 使用 Wald approximation：

$$
SE(C)=\sqrt{\frac{1}{9n}+\frac{C^2}{2\nu}},
$$

$$
CI(C)=C\pm z_{1-\alpha/2}SE(C).
$$

$Cpk$ 使用 point estimate 较小一侧的区间；两侧相等时先取区间交集，交集为空时取并集并产生 approximation warning。

Overall $Pp/Ppl/Ppu/Ppk$ 继续使用 $n-1$。$Cpm$ 区间当前 unavailable，point estimate 保留。

## 7. Nonconformance

Observed nonconformance 使用严格规格边界：

$$
N_{below}=\#\{x_i<LSL\},\qquad
N_{above}=\#\{x_i>USL\}.
$$

等于规格限的观测视为 conforming。比例和 PPM 为：

$$
p=\frac{N_{tail}}{n},\qquad PPM=p\times10^6.
$$

Observed proportion 区间使用 Wilson score interval。

Expected Normal nonconformance 分别使用 Within 和 Overall Sigma：

$$
P_{below}(s)=\Phi\left(\frac{LSL-\bar{x}}{s}\right),
$$

$$
P_{above}(s)=1-\Phi\left(\frac{USL-\bar{x}}{s}\right).
$$

Nested Subgroup 只改变 Expected Within 所使用的 sigma。Observed 和 Expected Overall 不变。

## 8. Capability Histogram

Process Capability 图使用竖向 Count Histogram：

- X 轴：响应变量名称及其数值单位。
- Y 轴：Count。
- Histogram：后端冻结的 bin count。
- 曲线：Overall Normal 和 Within Normal 同时显示，并在图例中明确区分。
- 规格线：LSL、Target、USL。

后端提供 Normal probability density：

$$
f(x;\bar{x},s)
=\frac{1}{s\sqrt{2\pi}}
\exp\left[-\frac{(x-\bar{x})^2}{2s^2}\right].
$$

为了与等宽 Count Histogram 共轴，Graph adapter 必须把 density 转为 expected bin count。设有效观测数为 $N$，公共 bin width 为 $\Delta$：

$$
y_{count}(x)=N\Delta f(x;\bar{x},s).
$$

Overall 曲线使用 $s_{overall}$，Within 曲线使用当前有效的 $s_{within}$ 或 $s_{within,nested}$。前端不得重新拟合参数或重新分箱。

若未来采用不等宽 bins，连续曲线不能使用单一 $\Delta$；届时必须改为每个 bin 的 expected count 或使用 Density 轴，并升级图表方法合同。

## 9. Nested Subgroup 边界状态

| 情况 | 行为 |
|------|------|
| 未选择标签列 | 执行默认 Individuals / MR(2)，结果与 provenance 保持不变 |
| 相同标签在表中不连续 | 在当前 By group 内合并为同一 subgroup，再按 `_row_id` 排序 |
| 相同标签出现在不同 By groups | 分别处理，不跨 By group 合并 |
| 标签缺失 | 观测保留在均值、Overall、Histogram 和 observed nonconformance 中；不产生 Within pair，并报告 warning |
| subgroup 只有一个有效观测 | 保留在 Overall；不产生 Within pair |
| $M=0$ | Within Sigma、Within indices、Within intervals、Expected Within 和 Within density unavailable；Overall 结果仍可用 |
| sigma 为 0 | 相关 finite-width index 使用 unbounded typed state，不序列化 IEEE infinity |
| $n<2$ | sigma 和 capability indices unavailable |
| Weight 或 Frequency 已配置 | Capability unavailable，不能静默忽略角色 |

Nested Subgroup 初版只允许一个 nominal 或 ordinal 标签列，并且不能同时承担 Response、Weight、Frequency 或 By 角色。

## 10. Provenance 与兼容性

默认路径使用 method version `1.1.0`。配置 Nested Subgroup 时使用 method version `2.0.0`，并记录 subgroup column identity、有效 subgroup 数、$M$、$A$、缺失标签数、singleton subgroup 数和 effective DF。

报告还记录 capability method ID、interval method、normal density method、computation ID 和 specification fingerprint。
当前产品路径的 specification source 为 `columnProperty`；兼容层中的 `analysisOverride` 枚举值不表示 UI 或 Analysis 文档仍拥有独立规格。

主要 interval method IDs：

- `movingRangeEffectiveDfChiSquare.v1`
- `movingRangeEffectiveDfWald.v1`
- `chiSquare.v1`
- `wald.v1`
- `wilson.v1`

与 JMP 19 的 exact interval 一致性当前保持 `compatibilityPending`，不得通过调整常数拟合单个截图。

## 11. 实现依据

- 统计实现：`src-tauri/src/services/normal_capability.rs`
- 数据分组与 source row order：`src-tauri/src/engine/distribution_executor.rs`
- 报告组装：`src-tauri/src/services/distribution_service.rs`
- 图形 adapter：`src/graphCore/distributionAdapter.ts`
- 当前开发方法规格：`docs/superpowers/specs/2026-08-26-distribution-normal-capability-method-v1.md`
- Moving Range effective DF 设计：`docs/superpowers/specs/2026-08-31-distribution-phase-a-layout-capability-design.md`
- Nested Subgroup 与 Count Histogram：[GitHub Issue 194](https://github.com/ashton2914/StatsPlayground/issues/194) 的批准设计
- Table 规格单一来源：`docs/superpowers/specs/2026-09-14-distribution-table-specification-source-design.md`
