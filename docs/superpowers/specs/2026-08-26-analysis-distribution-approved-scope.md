# Analyze Distribution 批准范围与验收台账

**日期：** 2026-08-26
**状态：** Platform Workflow、Continuous Descriptive、Normal Capability V1、Optimization Handbook Phase A 与 JMP Alignment Stage 1 已实现并通过自动门禁；正式 UI 验收待执行
**范围批准人：** 产品负责人
**关联跟踪：** GitHub Issue #49（仅作为需求跟踪入口；其图片和第三方素材不属于实现资料）
**总体设计：** [2026-08-25-analysis-distribution-design.md](2026-08-25-analysis-distribution-design.md)

**已批准 V1 规格与计划：**

- [Platform Workflow V1](2026-08-26-distribution-platform-workflow-v1.md) / [实施计划](../plans/2026-08-26-distribution-platform-workflow-v1.md)
- [Continuous Descriptive Methods V1](2026-08-26-distribution-continuous-descriptive-methods-v1.md) / [实施计划](../plans/2026-08-26-distribution-continuous-descriptive-v1.md)
- [Normal Process Capability V1](2026-08-26-distribution-normal-capability-method-v1.md) / [实施计划](../plans/2026-08-26-distribution-normal-capability-v1.md)
- [Optimization Handbook Phase A](2026-08-31-distribution-phase-a-layout-capability-design.md) / [实施计划](../plans/2026-08-31-distribution-phase-a-layout-capability.md) / [验收记录](../artifacts/2026-08-31-distribution-phase-a-layout-capability-acceptance.md)
- [JMP Terminology and Method Alignment](2026-08-31-distribution-jmp-terminology-and-method-alignment-design.md) / [Stage 1 实施计划](../plans/2026-08-31-distribution-jmp-alignment-stage-1.md) / [验收记录](../artifacts/2026-08-31-distribution-jmp-alignment-stage-1-acceptance.md)

## 1. 文档权威与维护规则

本文件是 Distribution 后续开发范围、capability registry、自动测试和人工 UI 验收的唯一状态台账。总体设计定义架构与长期目标；本文件决定某项能力当前是批准、暂缓还是不做。

任何能力进入实现前必须同时满足：

1. `scopeStatus = approved`。
2. 有独立、已评审的 versioned method spec。
3. capability registry 只暴露 `developmentStatus = implemented` 且自动门禁通过的能力。
4. 实现完成不等于验收完成；只有产品负责人在 StatsPlayground UI 中完成实际操作验收后，`uiAcceptance` 才能变为 `passed`。
5. 每次开发、范围变更、自动测试或人工验收后，必须同步更新本台账。不得删除暂缓项；未来恢复时沿用原 ID。

### 1.1 状态枚举

- `scopeStatus`：`approved`、`deferred`、`rejected`。
- `developmentStatus`：`notStarted`、`specified`、`implementing`、`implemented`。
- `automationStatus`：`notStarted`、`passing`、`failing`。
- `uiAcceptance`：`notReady`、`pending`、`passed`、`failed`。

## 2. 已批准的产品决策

### 2.1 Process Capability 与规格限

1. 首版 Process Capability 只支持 Normal capability。
2. Distribution 默认读取目标列的 Table 列属性 `LSL`、`Target`、`USL`。
3. 列属性存在至少一个有效规格边界（`LSL` 或 `USL`）时，自动生成 Process Capability 报告。
4. 列属性没有规格边界时，默认不生成 Process Capability 报告。
5. 列属性没有规格边界时，用户可在当前 Distribution 分析中手工输入有效 `LSL` 或 `USL`，从而启用 Process Capability。
6. 仅有 `Target` 不能启用 Process Capability。
7. 用户手工值覆盖当前分析读取到的列属性值；覆盖值随分析配置保存，但不回写 Table 列属性。
8. `LSL >= USL` 等无效组合阻止运行并返回结构化参数错误。
9. 单侧规格限合法；报告只显示定义成立的单侧指标和超规结果。
10. 列属性或当前分析规格发生变化后，新 revision 重算；新结果提交前保留旧有效报告。

规格值的产品级有效性规则：

- `LSL`、`Target`、`USL` 若存在，必须是可解析的有限数值；空值、NaN 和正负无穷视为未提供或无效输入。
- 规格值直接使用目标列的数值单位，不执行隐式单位换算。
- 同时存在 LSL 和 USL 时必须满足 `LSL < USL`。
- Target 若存在，必须位于已提供的规格边界内：有 LSL 时 `Target >= LSL`，有 USL 时 `Target <= USL`。
- 无效的列属性规格不自动启用 capability，并产生可定位到列属性的 warning；无效的手工规格阻止运行并返回结构化参数错误。
- 稳定错误/警告 code、字段路径和本地化消息由 Normal capability method spec 冻结，产品层不依赖自由文本判断错误类型。

### 2.2 本期范围裁剪

- `DESC-06`、`DESC-07` 扩展摘要统计暂缓。
- Letter-Value Quantile Plot 与 Stem-and-leaf 已按 2026-08-31 产品决策彻底移除，不进入 runtime、registry 或 UI。
- Equivalence tests 暂缓。
- Tolerance intervals 暂缓。
- 高级拟合、zero-inflated distributions 和 mixtures 全部暂缓。
- Process Capability 交互式情景分析 `CAP-18`、`CAP-19` 暂缓。
- Multiple Response 暂缓到连续变量能力稳定之后。
- 所有候选和暂缓能力保留在本台账，不进入当前 capability registry，不显示在当前 UI。

## 3. Phase 0 已开发基础设施

| ID | 能力 | scopeStatus | developmentStatus | automationStatus | uiAcceptance | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| INFRA-01 | Rust/TS versioned contracts 与 Filter AST | approved | implemented | passing | pending | Phase 0 自动门禁完成 |
| INFRA-02 | 空系统 bootstrap 与 capability allowlist | approved | implemented | passing | pending | 当前 registry 为空 |
| INFRA-03 | 项目 manifest、Distribution/Formula archive round-trip | approved | implemented | passing | pending | 支持 Directory folder map |
| INFRA-04 | unknown version preservation、corruption isolation、missing source | approved | implemented | passing | pending | 保留 raw payload |
| INFRA-05 | AnalysisSnapshot、stale/concurrency rejection | approved | implemented | passing | pending | schema fingerprint 使用 SHA-256 |
| INFRA-06 | progress、cancel、resource budget 控制面 | approved | implemented | passing | pending | 不包含统计计算 |
| INFRA-07 | sanitized BlackBoxCase、来源台账与法务流程记录 | approved | implemented | passing | pending | 不保存第三方自由文本 |
| INFRA-08 | deterministic seeds、golden runner、三平台 CI | approved | implemented | passing | pending | 仅 synthetic fixture |
| INFRA-09 | Graph Builder structural adapter | approved | implemented | passing | pending | 不执行统计推导 |
| INFRA-10 | Distribution empty-system Workspace skeleton | approved | implemented | passing | pending | 无真实报告或图表 |

## 4. 本期批准功能

### 4.1 平台与用户流程

| ID | 功能 | developmentStatus | automationStatus | uiAcceptance | 验收重点 |
| --- | --- | --- | --- | --- | --- |
| BASE-01 | `Analyze > Distribution` 启动入口与角色对话框 | implemented | passing | pending | 有活动数据集时启用；正式 Tauri UI 待验收 |
| BASE-02 | 一个或多个 Y 与建模类型识别 | implemented | passing | pending | 使用稳定 column ID；类型与冲突由 versioned config validator 校验 |
| BASE-03 | 可选 Weight、Freq、By | implemented | passing | pending | Weight/Freq singleton、By multi-role；真实统计贡献待 methods 验收 |
| BASE-04 | 列搜索、Remove、Recall、Histograms Only | implemented | passing | pending | CT 已覆盖 Cancel 不保存；正式 UI 待验收 |
| BASE-05 | Run 创建 `Distribution N` Directory 项 | implemented | passing | pending | 配置可原子保存为 Directory 项；空 registry 下 Run 按设计禁用 |
| BASE-06 | 重命名、移动、复制、删除、Edit Inputs、打开源表 | implemented | passing | pending | stable analysis ID；active run 删除前发送 cancel；正式 UI 待验收 |
| BASE-07 | save/open 后恢复配置并按当前数据重算 | implemented | passing | pending | archive/config 恢复已自动验证；registry 为空时不执行统计重算 |
| BASE-08 | progress、cancel、旧结果丢弃和旧有效报告保留 | implemented | passing | pending | 四键 identity 与状态机自动验证；真实长任务待 methods/UI 验收 |

### 4.2 连续描述统计与图表数据

| ID | 功能 | developmentStatus | automationStatus | uiAcceptance | 验收重点 |
| --- | --- | --- | --- | --- | --- |
| DESC-01 | Histogram count、probability、density chart-data | implemented | passing | pending | 后端冻结 bins；Overview 与 Capability chart 只映射预计算数据 |
| DESC-02 | Tukey box plot、outliers、均值区间 chart-data | implemented | passing | pending | 后端计算 quartiles/whiskers/outliers；与 Histogram 组合渲染 |
| DESC-03 | 批准概率点的 Quantiles | implemented | passing | pending | 11 个 Hyndman-Fan Type 6 概率点 |
| DESC-04 | Mean、sample Std Dev、Std Error Mean、Mean CI、N、N Missing | implemented | passing | pending | Rust kernel 与正式报告表格覆盖；公式未因术语调整而改变 |
| DESC-05 | Minimum、Maximum、Median、Mode、Range、IQR、MAD | implemented | passing | pending | 唯一众数显示数值；ties/all-unique 显示 No unique mode |
| DESC-09 | ECDF/CDF chart-data | implemented | passing | pending | 后端输出坐标；UI 默认隐藏并可恢复显示偏好 |

### 4.3 Normal Process Capability

| ID | 功能 | developmentStatus | automationStatus | uiAcceptance | 验收重点 |
| --- | --- | --- | --- | --- | --- |
| CAP-01 | 当前分析中手工输入 LSL/Target/USL | implemented | passing | pending | 分析级 override 编辑器；有效 LSL 或 USL 才生成报告 |
| CAP-02 | 自动读取 Table 列属性规格限 | implemented | passing | pending | 后端按稳定 column UUID 读取权威 extras |
| CAP-03 | 手工值覆盖当前分析且不回写 Table | implemented | passing | pending | override 与项目配置保存；不调用 Table 写入路径 |
| CAP-04 | 双侧、单侧、无 Target、无规格状态 | implemented | passing | pending | typed state 与规格解析测试覆盖 |
| CAP-05 | Process Summary：N、Mean、Within/Overall Sigma、Stability Index | implemented | passing | pending | Stability = Overall Sigma / Within Sigma，typed state/provenance |
| CAP-06 | Within：Cp、Cpk、Cpl、Cpu、Cpm | implemented | passing | pending | typed point estimate 与 CI 表格 |
| CAP-07 | Overall：Pp、Ppk、Ppl、Ppu、Cpm | implemented | passing | pending | 与 Within 分区展示 |
| CAP-08 | 能力指数置信区间 | implemented | passing | pending | chi-square/Wald；Cpm CI 按规格标记 deferred |
| CAP-09 | Below LSL、Above USL、Total Outside | implemented | passing | pending | 严格边界和单侧 typed state |
| CAP-10 | Observed、Expected Within、Expected Overall | implemented | passing | pending | 默认四列百分比显示，直接使用 typed proportion；Wilson 与 Normal tails 保留在 payload |
| CAP-11 | Expected PPM | implemented | passing | pending | 比例与 PPM 同源输出 |
| CAP-12 | Histogram、规格限线、Normal density chart-data | implemented | passing | pending | 后端 density/spec payload；ECharts canvas pixel test |
| CAP-13 | Within Sigma：average moving range | implemented | passing | pending | source row order MR window 2 |

### 4.4 Visual Diagnostics V1

| ID | 功能 | developmentStatus | automationStatus | uiAcceptance | 验收重点 |
| --- | --- | --- | --- | --- | --- |
| VIS-01 | Display 与 Histogram 分组菜单 | implemented | passing | pending | 只显示真实 backend 能力；显示偏好不增加 revision |
| VIS-02 | Histogram methods、scale 与 JMP Auto 兼容矩阵 | implemented | passing | pending | 公开 methods 为 `intentionalDifference`；`jmpAuto` 为 FD fallback 且 `compatibilityPending` |
| VIS-03 | Normal Quantile Plot | implemented | passing | pending | $r_i/(N+1)$ normal scores 为 `documentedCompatible`；line/band 为 `compatibilityPending` |
| VIS-04 | Letter-Value Quantile Plot | removed | passing | notApplicable | backend compute、IPC、adapter、menu、preferences 与 UI 已删除；旧偏好读取时丢弃 |
| DESC-08 | Stem-and-leaf | removed | passing | notApplicable | backend compute、IPC、component、menu、preferences 与 UI 已删除；旧偏好读取时丢弃 |
| DESC-10 | Normal Q-Q、通用 Q-Q、P-P | implemented | passing | pending | 本阶段仅实现 Normal Quantile Plot；其他 Q-Q/P-P 仍 deferred |
| VIS-05 | Overview/Capability axis 与规格线修复 | implemented | passing | pending | extent 隔离；LSL/Target/USL 可见且线型两两不同 |
| VIS-06 | Quantiles/Summary 横向表格与紧凑 Nonconformance | implemented | passing | pending | 响应式双栏、单线表格、三行五列 Nonconformance |

### 4.5 Visual compatibility evidence matrix（Task 1）

- Fixture：`tests/fixtures/distribution/jmp19-visual-diagnostics-v1.json`。
- Comparator：`tests/distributionVisualCompatibility.test.ts`。
- Case 只允许机器字段：`caseId`、`methodId`、`inputHash`、`input`、`expected`、`jmpVersion`、`compatibilityStatus`、`schemaVersion`。
- 明确禁止字段与内容：截图、帮助正文、绝对路径、可见列名、自由文本。
- `normalScore.documented.*` deterministic cases 可标 `documentedCompatible`。
- `histogram.jmpAuto.*` 在黑盒证据到位前只能是 machine-only `compatibilityPending`，且 comparator 必须判定 `compatible=false`。
- Task 1 已建立 pending marker coverage：
	- Histogram pending class 覆盖 `constant`、`narrowDecimal`、`mixedSign`、`outlier`、`boundary`，并覆盖 `count`、`probability`、`density` markers。
- Letter-Value Quantile Plot 与 Stem-and-leaf 的 pending cases 已从 fixture/comparator 移除，不再是 active compatibility target。
- 当前仍缺 Histogram JMP 桌面黑盒 numeric breadth；pending 仅为 machine marker 覆盖，不代表 bins 数值兼容已冻结。

### 4.6 Optimization Handbook Phase A

| ID | 功能 | developmentStatus | automationStatus | uiAcceptance | 兼容状态与验收重点 |
| --- | --- | --- | --- | --- | --- |
| OPT-A-01 | Overview 横向 Count Histogram 与右侧 Tukey Box | implemented | passing | pending | 后端 bins 直接映射为 `[count, lower, upper]`；共享 value Y extent |
| OPT-A-02 | 独立 Fit Density 图 | implemented | passing | pending | 后端 density/PDF coordinates；失败或空 curve 不渲染；颜色跨顺序/子集稳定 |
| OPT-A-03 | 五类 report 统一外边界与响应式双栏 | implemented | passing | pending | `1440x900`、`1024x700`、`768x900` CT；外缘 `<=2px`、paired top `<=3px`、无横向 overflow |
| OPT-A-04 | Moving Range effective-DF Within interval | implemented | passing | pending | 公开近似已实现；JMP 19 exact interval 仍为 `compatibilityPending` |
| OPT-A-05 | 参数化 confidence headings 与 camelCase interval contract | implemented | passing | pending | `Lower/Upper 95%`、`90%`；旧 `Lower/Upper CI` 缺席；Rust serde 已锁定 |

Phase A 自动门禁和 Tauri process/render smoke 不构成产品 UI 验收。51-row missing-region 真实场景、规格线与 scrollbar、wide/narrow report 对齐仍需产品负责人在桌面应用中签字；在此之前所有 `uiAcceptance` 保持 `pending`。Phase B-E 未进入本次实现。

## 5. 暂缓功能清单

暂缓项不得进入当前 method implementation、capability registry 或 UI。恢复开发时必须先将对应 `scopeStatus` 改为 `approved` 并补 method spec。

| ID | 功能 | scopeStatus | 原因/恢复条件 |
| --- | --- | --- | --- |
| DESC-06 | Sum、Variance、Skewness、Kurtosis、CV、N Unique/Zero 等扩展摘要 | deferred | 首版控制报告密度；按用户需求恢复 |
| DESC-07 | Geometric/trimmed/Huber robust mean、robust Std Dev | deferred | 使用频率较低，需独立方法规格 |
| TEST-01 | Test Mean 与均值区间检验报告 | deferred | 连续描述稳定后评审 |
| TEST-02 | Test Std Dev 与方差区间 | deferred | 连续描述稳定后评审 |
| TEST-03 | Wilcoxon signed-rank | deferred | 需独立 method spec |
| TEST-04 | Equivalence tests | deferred | 本期明确暂缓 |
| TEST-05 | Prediction intervals | deferred | 本期不交付 |
| TEST-06 | Tolerance intervals | deferred | 本期明确暂缓 |
| FIT-01 | Normal、Lognormal、Weibull、Exponential、Gamma 通用拟合 UI | implemented | 五模型自由参数输出 Estimate、Std Error、Lower 95%、Upper 95%；固定 Location 不输出；Measures 保持 -2*LogLikelihood/AICc/BIC；人工 UI 验收 pending |
| FIT-02 | Poisson、Negative Binomial、Binomial | deferred | 离散分布阶段另行批准 |
| FIT-03 | Anderson-Darling、Shapiro-Wilk、Pearson chi-square | approved | Continuous Fit Stage 2；Shapiro-Wilk 仅用于 Normal 辅助诊断 |
| FIT-04 | Fit All、AIC/AICc/BIC 稳定排序 | implemented | Exponential 固定 location 使用自由参数数 k=1，其他 Stage 1 模型 k=2；Fit All、partial failure 与稳定排序通过；Stage 2 再扩展候选与 GOF |
| FIT-05 | Cauchy、Student t、极值、Johnson、Beta | approved | Cauchy、Student t 属 Stage 2；Johnson 属 Stage 3；未列明模型仍不进入 registry |
| FIT-06 | Zero-inflated 系列 | deferred | 本期明确暂缓 |
| FIT-07 | sinh-arcsinh 系列 | approved | Continuous Fit Stage 3，先冻结参数化与优化约束 |
| FIT-08 | EMG、Normal mixtures、nonparametric density | approved | Stage 3 交付 Normal mixtures 与 Smooth Curve；EMG 需另行 method spec 后才注册 |
| CAP-14 | 其他 Within Sigma 估计方法 | deferred | 首版只用 average moving range |
| CAP-15 | Stability Index | implemented | Stage 1 已冻结为 Overall Sigma / Within Sigma，并提供 typed state 与 method provenance；自动门禁 passing，人工 UI 验收 pending |
| CAP-16 | Nonnormal capability | deferred | 首版只支持 Normal capability |
| CAP-17 | K-sigma、quantile limits | deferred | 本期明确暂缓 |
| CAP-18 | 交互式调整规格限、均值、Sigma | deferred | 情景分析明确暂缓 |
| CAP-19 | Original/New 对比与 Mean Shift 情景 | deferred | 情景分析明确暂缓 |
| CAP-20 | 将分析规格自动写回 Table 列属性 | deferred | 当前设计明确不自动回写 |
| CAT-01 | Nominal/Ordinal frequency/probability 报告 | deferred | 连续变量稳定后评审 |
| CAT-02 | Multiple Response | deferred | 连续变量稳定后再开发 |
| SAVE-01 | Standardized、Centered、Ranks 派生列 | deferred | 描述统计稳定后评审 |
| SAVE-02 | Robust/Probability Scores 派生列 | deferred | 使用频率与方法规格待确认 |

## 6. 开发与验收台账流程

### 6.1 开发更新

每个开发分支开始时，在对应条目记录 branch/plan；完成 method spec 后改为 `specified`，首个生产代码提交后改为 `implementing`，所有自动门禁通过后改为 `implemented`。

每项至少关联：

- method spec 路径与版本；
- capability ID；
- Rust unit/property test；
- synthetic/golden fixture ID；
- TS contract/store test；
- Playwright 或 Tauri UI test；
- 已知差异和限制。

### 6.2 UI 人工验收

产品验收必须在 StatsPlayground 界面中模拟真实用户操作。每项批准功能至少覆盖：

1. 从活动表启动 Distribution，选择 Y/Weight/Freq/By 并运行。
2. 在 Directory 中打开、重命名、移动、复制、删除与 Edit Inputs。
3. 查看真实统计报告和 Graph Builder 图形，而不是测试专用页面。
4. 修改输入后确认旧有效报告保留，新 revision 完成后原子替换。
5. 修改源数据后确认重算、stale result 丢弃和 missing-source 状态。
6. 保存、关闭、重新打开项目后恢复配置并按当前数据重算。
7. 验证空数据、n=1、常数列、缺失、Weight/Freq、By 和过滤。
8. 验证长任务进度、取消、资源预算和结构化错误。

Normal Process Capability 另需覆盖：

1. 列属性无规格且无手工规格时，不显示 capability 报告。
2. 列属性有双侧规格时，自动生成 capability 报告。
3. 列属性只有 LSL 或只有 USL 时，生成适用的单侧报告。
4. 列属性无规格，手工输入有效 LSL 或 USL 后启用报告。
5. 手工值覆盖列属性值，保存/打开后保持覆盖，但 Table 列属性不变。
6. 仅有 Target 时不启用；`LSL >= USL` 时阻止运行。
7. 核对 Within/Overall 指标、置信区间、observed/expected 超规比例和 PPM。
8. 核对规格线、Normal density 和 histogram 的 Graph Builder 交互与导出。

验收结果记录为 `passed` 或 `failed`。失败时必须记录复现步骤、预期、实际、受影响 ID、数据 fixture 和修复提交。

## 7. 变更控制

- 产品负责人可以将 `deferred` 项改为 `approved`；必须保留原 ID 和历史原因。
- 新增功能先进入 `deferred`，完成范围评审后才能批准。
- 当前批准项若删除或降级，必须记录影响、项目迁移和 UI 兼容策略。
- 产品批准只代表产品范围，不替代算法来源、依赖许可证或法律审查。
- 本文件不得包含第三方截图、帮助正文、原始产品输出或隔离 validation repository 内容。

Phase 0 已冻结的执行流程记录：

- [Analysis Distribution 来源台账流程记录](../artifacts/2026-08-25-analysis-distribution-source-ledger.md)
- [Analysis Distribution 法务复核流程记录](../artifacts/2026-08-25-analysis-distribution-legal-review-process.md)

具体人员授权、validation repository 准入和法律判断由组织政策维护，不在产品仓库中记录个人身份或法律结论。
