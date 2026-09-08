# Distribution Normal Process Capability V1 Specification

**版本：** 1.0.0
**状态：** 产品与方法口径已批准，待实现验证与依赖审计
**覆盖 ID：** CAP-01 至 CAP-13
**依赖：** [Platform Workflow V1](2026-08-26-distribution-platform-workflow-v1.md)、[Continuous Descriptive V1](2026-08-26-distribution-continuous-descriptive-methods-v1.md)
**范围权威：** [批准范围与验收台账](2026-08-26-analysis-distribution-approved-scope.md)

## 1. 方法与适用范围

method ID 为 `capability.normal.individuals`，version `1.0.0`。首版只支持连续 Y、Normal model、Individuals moving range window 2。不支持 Weight、Freq、nonnormal、subgroup、K-sigma、quantile limits、情景模拟或自动回写列属性。

设置 Weight 或 Freq 时，连续描述照常运行，Capability block 返回 unavailable，reason `capability.weightFreqUnsupported.v1`，不得静默忽略角色。

## 2. 规格来源与覆盖

```ts
interface SpecificationLimitsV1 {
  lsl: number | null;
  target: number | null;
  usl: number | null;
  source: "columnProperty" | "analysisOverride";
}

interface NormalCapabilityOverrideV1 {
  lsl: number | null;
  target: number | null;
  usl: number | null;
}
```

平台 config 使用 `CapabilityOverrideEnvelopeV1 { capabilityId: "capability.normal.individuals", payloadSchemaVersion: "1", payload: NormalCapabilityOverrideV1 }`。payload 只允许上述三个字段；额外字段、错误类型和未知 version 阻止保存和运行。

- 后端通过稳定 dataset/column ID 获取 `extras.spec.lsl/target/usl`；前端传来的列属性副本不作为权威。
- `analysisOverride` 每个字段可为 finite number 或 null；只要用户提交 override 对象，它按字段覆盖列属性。null 表示当前分析明确移除该字段。
- override 随 Distribution config 保存，不回写 Table。
- 无 override 时使用运行 snapshot 时的列属性。
- 至少一个有效 LSL/USL 才启用。Target 单独存在时不启用。

有效性：所有提供值必须 finite；双侧满足 `LSL < USL`；Target 若存在，满足已提供的边界。无效列属性产生 warning `capability.invalidColumnSpec.v1` 并禁用 block；无效手工 override 使请求失败 `capability.invalidOverride.v1`。

列属性在运行期间变化通过 schema/parameter fingerprint 使旧结果 stale。

## 3. 数据与顺序

使用 Continuous Descriptive V1 的 Y/Filter/By eligibility，但 Capability 禁止 Weight/Freq。N 是有效 Y 行数。

Moving range 必须使用过滤后、同一 By group 内稳定 source row ID 升序的相邻观测，不按 Y 排序：

$$MR_i=|x_i-x_{i-1}|,\quad i=2,\dots,n.$$

若 source row order 无法建立，Capability 全局失败，不得改用值排序。

## 4. Process Summary

$$
\bar{x}=\frac{1}{n}\sum x_i,\qquad
s_{overall}=\sqrt{\frac{\sum(x_i-\bar{x})^2}{n-1}}.
$$

$$
\overline{MR}=\frac{1}{n-1}\sum_{i=2}^{n}MR_i,
\qquad d_2(2)=\frac{2}{\sqrt{\pi}},
\qquad s_{within}=\frac{\overline{MR}}{d_2(2)}.
$$

输出 N、Mean、MRbar、d2、Within Sigma、Overall Sigma。n<2 时 sigma 和全部 indices unavailable。sigma=0 时 finite-width capability indices 为 positive infinity，不序列化 IEEE infinity；输出 `value=null`、state `unbounded`，并给稳定 reason。

## 5. Capability Indices

双侧：

$$Cp=\frac{USL-LSL}{6s_{within}},\quad
Cpk=\min(Cpu,Cpl),$$
$$Cpu=\frac{USL-\bar{x}}{3s_{within}},\quad
Cpl=\frac{\bar{x}-LSL}{3s_{within}}.$$

$$Pp=\frac{USL-LSL}{6s_{overall}},\quad
Ppk=\min(Ppu,Ppl),$$
$$Ppu=\frac{USL-\bar{x}}{3s_{overall}},\quad
Ppl=\frac{\bar{x}-LSL}{3s_{overall}}.$$

Target 且双侧存在时：

$$Cpm_{within}=\frac{USL-LSL}{6\sqrt{s_{within}^2+(\bar{x}-T)^2}},$$
$$Cpm_{overall}=\frac{USL-LSL}{6\sqrt{s_{overall}^2+(\bar{x}-T)^2}}.$$

单侧只输出对应 `Cpu/Ppu` 或 `Cpl/Ppl`；`Cp/Pp/Cpk/Ppk/Cpm` 为 notApplicable。指标允许负值，表示均值位于规格外，不做 0 截断。

## 6. 置信区间

分析级 confidenceLevel 适用于全部 capability CI。

### 6.1 Cp/Pp

令 $\nu=n-1$。对基于 sigma 的 potential index $I$：

$$I_L=I\sqrt{\frac{\chi^2_{\alpha/2,\nu}}{\nu}},\qquad
I_U=I\sqrt{\frac{\chi^2_{1-\alpha/2,\nu}}{\nu}}.$$

Within 的 MR estimator 并不严格服从样本方差卡方分布，因此 `Cp` CI 使用同一近似并标记 `intervalMethod=chiSquareApproximation.v1`；Pp 标记 `chiSquare.v1`。

所有 CI block provenance 必须记录 distribution crate 名称、精确版本、分布参数化、inverse-CDF algorithm ID 和 method version。n<3 时 Capability CI unavailable，reason `capability.intervalSampleTooSmall.v1`；极端尾部若 crate 返回非有限值，区间 unavailable 且 point estimate 保留，不做自定义静默截断。

### 6.2 Cpu/Cpl/Cpk 与 Ppu/Ppl/Ppk

使用 Wald 近似。对单侧 index $J$：

$$SE(J)=\sqrt{\frac{1}{9n}+\frac{J^2}{2(n-1)}}.$$

$$J_L=J-z_{1-\alpha/2}SE(J),\qquad J_U=J+z_{1-\alpha/2}SE(J).$$

不截断负下限。Cpk/Ppk 采用决定 point estimate 的较小侧区间，并标记 `limitingSide`；两侧相等时返回两侧 intersection，若空则使用 union 并 warning `capability.equalSidesApproximation.v1`。

### 6.3 Cpm

首版 Cpm 输出 point estimate，CI unavailable，reason `capability.cpmIntervalDeferred.v1`。CAP-08 验收要求适用于 Cp/Cpk/Cpl/Cpu/Pp/Ppk/Ppl/Ppu；Cpm CI 作为后续同 ID 扩展前必须升级 method version。

## 7. Observed 与 Expected Nonconformance

Observed 使用严格边界：`x < LSL`、`x > USL`；等于规格视为 conforming。

输出 below/above/total 的 count、proportion、PPM：

$$PPM=proportion\times10^6.$$

Expected Normal：

$$P_{below}(\sigma)=\Phi\left(\frac{LSL-\bar{x}}{\sigma}\right),$$
$$P_{above}(\sigma)=1-\Phi\left(\frac{USL-\bar{x}}{\sigma}\right).$$

分别用 `s_within` 和 `s_overall` 输出 Expected Within/Overall。单侧缺少的尾部字段为 notApplicable，不填 0；total 等于适用尾部之和。

Observed proportion 的 CI 使用 Wilson score，confidenceLevel 与分析一致；Expected PPM 不提供采样 CI。

## 8. Chart-data

Distribution 输出预计算：

- 与 DESC-01 相同 bins，保持 count/probability/density；
- specification lines：LSL/Target/USL 数值、source；
- Normal density coordinates，分别可标识 overall/within sigma；首版默认显示 overall density，within 为可切换 series；
- observed below/above bin contributions；
- provenance 包含 capability method、normal CDF method、snapshot、spec fingerprint。

Graph Builder 只渲染，不重新计算 density、indices、PPM 或规格来源。

## 9. Block 状态

- 无 LSL/USL：block absent，不生成 unavailable 占位。
- 无效列属性规格：block absent，变量 warning。
- 无效 override：全局 run failure。
- Weight/Freq 存在：block unavailable，连续描述仍可用。
- n<2、MR unavailable：summary 部分可用，indices unavailable。
- constant：sigma=0，indices 使用 `unbounded/notApplicable` 状态，expected tails 根据均值与规格精确为 0 或 1，不调用除零。
- 非有限中间值：block failed，旧报告保留。

## 10. 返回合同

`ProcessCapabilityBlockV1` 包含：spec source、process summary、typed indices、typed intervals、observed/expected nonconformance、chart-data IDs、warnings、method provenance。每个可选数值使用 `{state,value,reasonCode?}`，state 为 `available/notApplicable/unavailable/unbounded`，不以 null 单独表达语义。

## 11. 黄金矩阵

覆盖：无规格、Target-only、LSL-only、USL-only、双侧、override add/remove、无效顺序、n=1/2、常数、均值规格内/外、边界相等、outliers、By/Missing group、Filter、列属性运行中变化、Weight/Freq unavailable。

精确字段：N、observed counts、spec source、state、limitingSide。浮点：indices/PPM `abs <= 1e-10` 或 `rel <= 1e-9`；Normal tails 在小于 `1e-300` 时使用 log-CDF 路径并以相对/ULP 容差验收。

## 12. 公开算法来源类别与依赖

使用公开的 normal distribution、Individuals moving range、capability index、chi-square/Wald/Wilson interval 定义。实现可使用许可证兼容的 Rust distribution crate 提供 Normal/t/chi-square CDF 与 inverse CDF，但参数化、尾部、容差和版本必须在实现中锁定。不得使用第三方产品截图、帮助文本或输出作为实现资料。

## 13. 明确不做

Weight/Freq capability、subgroup capability、其他 within sigma、nonnormal、K-sigma、quantile limits、stability index、情景模拟、自动写回列属性、通用拟合 UI 均不属于 V1。
