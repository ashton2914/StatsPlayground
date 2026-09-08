# Distribution Fit Inference 与诊断移除设计

**日期：** 2026-08-31
**状态：** 已批准
**目标：** 彻底移除 Letter-Value Quantile Plot 与 Stem-and-Leaf，并为五种 Continuous Fit 的自由参数提供固定 95% 标准误和置信区间

**依赖：**

- [Distribution JMP 术语与方法对齐设计](2026-08-31-distribution-jmp-terminology-and-method-alignment-design.md)
- [Continuous Fit 设计](2026-08-28-distribution-continuous-fit-jmp19-design.md)
- [Distribution 优化设计手册](2026-08-31-distribution-optimization-handbook.md)

## 1. 批准决策

1. Letter-Value Quantile Plot 与 Stem-and-Leaf 从产品和计算合同中彻底移除，不采用仅隐藏 UI 的方案。
2. Rust 不再计算或返回 `quantileBox`、`quantileBoxData`、`stemAndLeaf` 或 `stemAndLeafData`。
3. 删除对应 React 组件、graphCore adapter、i18n 文案、显示偏好和专属测试。
4. 旧项目中遗留的 `quantileBoxPlot`、`stemAndLeaf` 偏好字段在读取时忽略，不阻止项目打开；写回时不再产生这些字段。
5. Continuous Fit 参数表只显示自由估计参数。Exponential、Gamma、Weibull 的固定 Location 0 不进入最终参数数组或 UI。
6. Normal、Lognormal、Exponential、Gamma、Weibull 的自由参数都返回 Estimate、Std Error、Lower 95%、Upper 95%。
7. 参数置信水平固定为 95%，不跟随 Distribution 的 Mean/Capability `confidenceLevel`。
8. 参数推断仍为 `compatibilityPending`，不得仅因术语一致而声明 JMP 数值兼容。

## 2. 删除边界

彻底移除以下运行时能力：

- `quantileBox.public.letterValue.type6.v1`
- `stemLeaf.public.decimal.v1`
- `QuantileBoxDataV1`、`StemAndLeafDataV1` 及其嵌套类型
- `DistributionChartDataV1::QuantileBoxData`
- graphCore 的 `quantileBoxData` adapter 分支
- `StemAndLeafReport`
- Y-level Diagnostic Plots 中的两个菜单项
- `DistributionYReportPreferencesV1.quantileBoxPlot`
- `DistributionYReportPreferencesV1.stemAndLeaf`

兼容读取规则：项目 JSON 采用 serde/TypeScript 的宽松对象读取，未知旧字段被忽略。不得因为删除字段而拒绝旧 archive。旧结果中的历史 block 不迁移为新 block；重新运行后不再生成这两类 block。

保留：Normal Quantile Plot、ECDF、Overview、Fit Density 和 Process Capability。

## 3. 参数合同

`DistributionFitParameterV1` 调整为：

```rust
pub struct DistributionFitParameterV1 {
    pub parameter_id: String,
    pub estimate: CapabilityTypedValueV1,
    pub standard_error: CapabilityTypedValueV1,
    pub lower_confidence: CapabilityTypedValueV1,
    pub upper_confidence: CapabilityTypedValueV1,
}
```

规则：

- `value` 更名为 `estimate`，Rust serde 和 TypeScript 同步使用 camelCase。
- `fixed` 不再由新 payload 输出；Rust 反序列化可临时保留 legacy alias/default 兼容，但新运行结果不含固定参数行。
- 四个数值字段都使用 typed state；available 时必须 finite。
- 一个参数的区间计算失败不得使整个 fit 失败；Estimate 保持 available，SE/limits 返回同一稳定 reason code 的 typed unavailable。
- `estimatedParameterCount` 保留，并等于最终参数数组长度。

稳定 reason codes：

- `distribution.fit.parameterInferenceUnavailable.v1`
- `distribution.fit.parameterInformationSingular.v1`
- `distribution.fit.parameterIntervalNonFinite.v1`

## 4. 模型与参数行

| 模型 | 最终参数行 | 固定参数处理 |
| --- | --- | --- |
| Normal | Location、Dispersion | 无 |
| Lognormal | Scale、Shape | 参数仍是 log-location/log-scale；报告保留 natural-log 说明 |
| Exponential | Scale | Location 0 不输出 |
| Gamma | Shape、Scale | Location 0 不输出 |
| Weibull | Shape、Scale | Location 0 不输出 |

内部 PDF 计算可以继续使用模型所需的固定 Location 常数，但固定值不得进入公开参数数组。

## 5. 参数推断方法

令总似然贡献为：

$$
W=\sum_i f_iw_i.
$$

标准误来自 MLE 的渐近协方差矩阵。95% Wald limits 使用：

$$
\widehat\theta_j \pm z_{0.975}SE(\widehat\theta_j),
\qquad z_{0.975}=1.959963984540054.
$$

不截断或裁剪 limits；若结果非 finite，则 limits typed unavailable。相同 Weight 缩放语义沿用当前加权 likelihood，并保持 `compatibilityPending`。

### 5.1 Normal

参数为 $\mu,\sigma$：

$$
SE(\widehat\mu)=\frac{\widehat\sigma}{\sqrt W},
\qquad
SE(\widehat\sigma)=\frac{\widehat\sigma}{\sqrt{2W}}.
$$

### 5.2 Lognormal

参数为 log-location $\mu_{\log}$ 与 log-scale $\sigma_{\log}$，使用与 Normal 相同的信息矩阵公式：

$$
SE(\widehat\mu_{\log})=\frac{\widehat\sigma_{\log}}{\sqrt W},
\qquad
SE(\widehat\sigma_{\log})=\frac{\widehat\sigma_{\log}}{\sqrt{2W}}.
$$

UI 名称仍为 Scale、Shape，并显示 natural-log parameterization 说明。

### 5.3 Exponential

Location 固定为 0，唯一自由参数为 scale $\theta$：

$$
SE(\widehat\theta)=\frac{\widehat\theta}{\sqrt W}.
$$

### 5.4 Gamma

参数为 shape $\alpha$、scale $\theta$。在 MLE 处使用解析 observed information：

$$
I(\alpha,\theta)=W
\begin{bmatrix}
\psi_1(\alpha) & 1/\theta\\
1/\theta & \alpha/\theta^2
\end{bmatrix},
$$

其中 $\psi_1$ 为 trigamma。协方差为 $I^{-1}$。矩阵 determinant 必须 finite 且严格为正，对角协方差必须 finite 且非负，否则两个参数的 SE/limits typed unavailable。

### 5.5 Weibull

参数为 shape $k$、scale $\lambda$。在 transformed parameters $\eta=(\log k,\log\lambda)$ 上，对 negative log-likelihood 使用确定性中心差分 Hessian：

$$
H_{jj}\approx\frac{g(\eta+h_je_j)-2g(\eta)+g(\eta-h_je_j)}{h_j^2},
$$

$$
H_{jk}\approx\frac{g(\eta+h_je_j+h_ke_k)-g(\eta+h_je_j-h_ke_k)-g(\eta-h_je_j+h_ke_k)+g(\eta-h_je_j-h_ke_k)}{4h_jh_k}.
$$

步长固定为：

$$
h_j=\sqrt[3]{\epsilon}\max(1,|\eta_j|).
$$

要求 Hessian symmetric、finite、determinant $>0$ 且 diagonal $>0$。反矩阵得到 transformed covariance，再用 delta method：

$$
\operatorname{Cov}(k,\lambda)=JH^{-1}J^T,
\qquad J=\operatorname{diag}(k,\lambda).
$$

数值 Hessian 不调用随机过程，不改变现有 optimizer 结果。Hessian 评估前将 transformed MLE center 规范到 $10^{-8}$ 网格，避免等价 Frequency 表示中的亚纳米级 optimizer 中心差异被二阶差分放大；公开 Estimate 不舍入。

Weibull Frequency 压缩与逻辑展开的 Estimate 沿用全局严格容差；SE 与 Wald limits 因 profile optimizer 中心和有限差分误差，采用相对容差 $10^{-5}$ 或绝对容差 $10^{-8}$。

## 6. 架构

- `distribution_fit.rs` 拥有参数推断数学和 typed failure，不放入 React 或 `distribution_service.rs`。
- `FitEstimateV1` 的参数在 model fit 完成后由统一 `attach_parameter_inference(...)` 转为公开参数合同。
- `distribution_service.rs` 只组装最终 payload，不再补固定 Location 行。
- React 只格式化四列，不重算 limits。
- 不新增 Tauri command；沿现有 Distribution run result IPC 返回。

## 7. UI

参数表固定列：

```text
Parameter | Estimate | Std Error | Lower 95% | Upper 95%
```

- unavailable 使用现有 typed reason formatter。
- 表格保持完整 grid lines 与响应式外边界。
- 不显示 Location Fixed 行。
- Measures 表、Fit Comparison、Fit Density 和 convergence 行保持不变。

四语言均增加 Std Error、Lower 95%、Upper 95% 的参数表文案，并删除 Letter-Value/Stem 专属入口文案。

## 8. 验收

### 8.1 参数推断

- 五模型 fixture 均验证参数行数、顺序、Estimate、SE、Lower 95%、Upper 95%。
- Exponential 只包含 Scale，一行且 `estimatedParameterCount=1`。
- Gamma/Weibull 各两行，不含 Location。
- frequency compact 输入与逻辑展开输入的 Estimate/SE/limits 一致。
- singular/non-finite information 返回 typed unavailable，不产生 NaN/Infinity。
- UI 精确验证五列和 Location 缺席。

### 8.2 诊断移除

- backend result 不包含 `quantileBox` 或 `stemAndLeaf` block。
- bootstrap/menu/preferences/contracts 不再包含两个能力。
- graph adapter 不再接受 `quantileBoxData`。
- 旧 archive 含遗留偏好字段仍可打开，保存后字段消失。

### 8.3 门禁

- `npm run test:distribution`
- `npm run build`
- `cargo test --lib`
- `cargo clippy --lib --tests`
- 四语言 JSON parse
- `git diff --check`
- Tauri smoke

## 9. 非目标

- 不新增 Cauchy、Student's t、GOF、Q-Q/P-P/CDF model diagnostics。
- 不声称参数 SE/CI 与 JMP 19 数值完全一致。
- 不实现 bootstrap、profile likelihood 或 Bayesian intervals。
- 不改变当前 MLE point estimates、AIC/AICc/BIC 或 fitted PDF。
- 不保留 Letter-Value 或 Stem 的隐藏计算路径。
