# Distribution Phase A 布局与 Capability 区间优化设计

**日期：** 2026-08-31
**状态：** 已批准
**阶段：** Optimization Handbook Phase A

**依赖：**

- [Distribution 优化设计手册](2026-08-31-distribution-optimization-handbook.md)
- [Distribution 批准范围与验收台账](2026-08-26-analysis-distribution-approved-scope.md)
- [Normal Process Capability V1](2026-08-26-distribution-normal-capability-method-v1.md)
- [Distribution Visual Diagnostics Design](2026-08-27-distribution-visual-diagnostics-jmp19-design.md)
- [Continuous Fit Design](2026-08-28-distribution-continuous-fit-jmp19-design.md)

## 1. 目标

本阶段只处理三个已确认的P0缺陷：

1. Overview改为横向Count Histogram，Y轴为被分析变量，X轴为bin count。
2. 统一Distribution报告图表和表格的左右外边界。
3. 修正Normal Process Capability中Within interval错误使用$n-1$自由度的问题，并用51行缺失region样本形成可复现证据。

本阶段不新增Custom Quantiles、Summary定制、推断检验、Continuous Fit Stage 2或高级分布。

## 2. Overview横向Count Histogram

### 2.1 坐标语义

Overview固定使用：

- Y轴：连续变量值，例如`sales_amount`。
- X轴：`Frequency / Count`。
- 每个bar：一个后端bin $[lower,upper)$；最后一箱右闭。
- bar长度：后端返回的`bin.count`。
- 空bin继续显示为零长度。

前端不得重新分箱、归一化或用density替换count。

### 2.2 Box Plot

Tukey Outlier Box Plot置于Histogram右侧：

- 与Histogram共享Y轴value extent。
- box、whisker和outlier均沿Y方向表达数值。
- box panel隐藏重复Y轴标签。
- Histogram与Box使用独立X轴。

LSL、Target、USL在两个panel中均为横向markLine；label只在Histogram panel显示，避免右侧文字与滚动条冲突。

### 2.3 Fit Density边界

fitted PDF不能与Count axis共轴。存在成功fit curves时：

- Overview仍保持横向Count，不切换scale。
- 新增独立`Fit Density`图：X轴为变量值，Y轴为Probability Density。
- Histogram density和全部fitted PDF在该图共轴。
- Rust继续拥有bins与PDF coordinates；graphCore只映射。
- `Show Fit Curves`只控制Fit Density图，不改变Overview。

Process Capability Histogram继续保持竖向Probability Density，不纳入本次方向变更。

## 3. 报告外边界对齐

### 3.1 统一容器

每个Y report使用同一个内容坐标系：

- `.distribution-y-content`定义唯一左右gutter。
- `.distribution-report-block`、`.distribution-table-pair`、`.distribution-chart`、Capability和Fit report均`width:100%`、`box-sizing:border-box`。
- DOM层外边界必须对齐；ECharts内部grid可为轴标签保留padding。
- 不使用Quantiles独立`min(360px,100%)`等会破坏外边界的宽度。

### 3.2 响应式布局

- 宽度大于900px时，Quantiles/Summary与Capability双栏使用统一grid gap和边界。
- 900px及以下转为单栏。
- 表格外框填满所属grid cell。
- 长数字不得扩张父容器；使用tabular numerals、合理换行或水平滚动。
- 图例、规格文字和页面scrollbar之间保留安全距离。

### 3.3 验收

Playwright在`1440x900`、`1024x700`、`768x900`下测量：

- Overview、table pair、Capability、Fit Comparison左右外边界差异不超过2px。
- 双栏cell顶部差异不超过3px。
- 窄屏无横向溢出和重叠。

## 4. Capability 95%区间

### 4.1 已确认事实

本地synthetic CSV中`region=Missing`且`sales_amount`有效的51行，与JMP截图一致：

- $N=51$
- mean $=523.723921568627$
- average moving range $=677.5516$
- within sigma $=600.464471303597$
- overall sigma $=731.775276729348$
- Cpl/Cpk $=-0.264393149633$
- Ppl/Ppk $=-0.216950063577$

当前Overall区间与JMP三位小数基本一致。主要差异来自Within interval把$n-1$误当作Average Moving Range sigma estimator的自由度。

### 4.2 Moving Range effective degrees of freedom

令$m=n-1$，对individual moving ranges $R_i=|X_i-X_{i-1}|$：

$$
d_2=\frac{2}{\sqrt\pi},
$$

$$
\frac{Var(R_i)}{\sigma^2}=2\left(1-\frac{2}{\pi}\right),
$$

相邻moving ranges共享一个观测，相关协方差为：

$$
\frac{Cov(R_i,R_{i+1})}{\sigma^2}
=\frac{1}{3}+\frac{2\sqrt3-4}{\pi}.
$$

因此：

$$
r_{MR}=\frac{Var(\bar R/d_2)}{\sigma^2}
=\frac{m v+2(m-1)c}{m^2d_2^2},
$$

$$
\nu_{MR}=\frac{1}{2r_{MR}}.
$$

当$n=51$时，$\nu_{MR}=30.43832706934947$。

### 4.3 区间方法

- Within Cp使用$\nu_{MR}$的chi-square approximation。
- Within Cpl/Cpu使用：

$$
SE(C)=\sqrt{\frac{1}{9n}+\frac{C^2}{2\nu_{MR}}},
$$

$$
CI=C\pm z_{1-\alpha/2}SE(C).
$$

- Within Cpk继续由limiting side组合，但method ID更新为`movingRangeEffectiveDfWald.v1`。
- Overall Pp/Ppl/Ppu/Ppk继续使用$n-1$与现有overall方法。
- Cpm interval继续deferred。

该公开近似对51行样本产生：

- Cpl约`[-0.377443,-0.151343]`。
- Cpu约`[1.017419,1.731871]`。

结果显著接近JMP，但不宣称三位小数完全一致。JMP截图的非对称one-sided interval与Cpk专用区间可能依赖非中心$t$或未公开修正；在更广脱敏fixture与独立method revision完成前保持`compatibilityPending`。

### 4.4 合同与标题

`ProcessCapabilityIntervalsV1`增加：

- `confidenceLevel: number`
- provenance method/version更新
- Within effective degrees of freedom进入provenance

UI列标题根据confidence level显示：

- `Lower 95%`
- `Upper 95%`

若confidence level为0.90，则显示`Lower 90% / Upper 90%`。不得将固定文案`Lower CI`用于所有配置。

### 4.5 Fixture

新增machine-only fixture，保存：

- case ID
- $n$、mean、MR average、within/overall sigma
- LSL、Target、USL
- point estimates
- 当前公开方法expected intervals
- JMP 19 observed rounded values
- 两者独立compatibility status

测试不得把公开近似expected值替换成JMP截图值，也不得通过调常数让单个case通过。

## 5. 测试与门禁

### 5.1 Adapter与Canvas

- 横向Count tuple只含`[count,lower,upper]`坐标字段。
- Box与Histogram共享Y extent。
- 规格线使用Y轴。
- Fit Density独立图直接映射density bins和PDF coordinates。
- Overview、Fit Density、Capability均非空。

### 5.2 Rust

- effective DF公式单元测试。
- $n<3$ typed unavailable。
- n=51 fixture数值测试。
- Overall interval回归不变。
- available numeric fields finite。

### 5.3 Layout

- 三种viewport外边界测量。
- 所有表格完整网格。
- 菜单、legend、规格label不与scrollbar重叠。

### 5.4 完整门禁

- `npm run test:distribution`
- `npm run build`
- `cargo test --lib`
- 四语言JSON parse
- `git diff --check`
- Tauri desktop smoke与正式截图

严格Clippy若仍被仓库既有基线阻塞，必须记录且不得添加blanket allow。

## 6. 非目标

- 不改变Process Capability Histogram方向。
- 不把PDF缩放到Count axis。
- 不实现JMP未公开的非中心$t$/Cpk exact interval，除非另立method spec。
- 不新增Phase B–E功能。
- 不改变Weight/Freq、By、Missing和四键run identity语义。
- 不复制JMP界面、文案或代码。
