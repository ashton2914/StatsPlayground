# Analyze Distribution 总体设计

**日期：** 2026-08-25
**状态：** 总体架构已评审；当前产品范围见批准范围与验收台账
**目标基准：** JMP Pro 19.0 黑盒兼容
**许可证边界：** StatsPlayground 保持 Apache-2.0；本设计不授予任何第三方知识产权许可
**范围台账：** [2026-08-26-analysis-distribution-approved-scope.md](2026-08-26-analysis-distribution-approved-scope.md)

## 1. 目标与规格层级

在现有 StatsPlayground 工作区中新增 `Analyze > Distribution`，覆盖 Continuous、Nominal、Ordinal 和 Multiple Response 的单变量分布分析。平台在可观察输入、数值输出、报告结构和操作语义上以用户持有的 JMP Pro 19.0 环境为黑盒验收基准，同时使用 StatsPlayground 自有视觉设计、项目持久化、错误处理和跨平台架构。

“兼容”不表示复制 JMP 软件、源码、JSL、文档、界面素材或品牌表达。统计方法必须独立实现；JMP 只能在经法律审查的隔离流程中作为黑盒验收参考。

本文只冻结总体架构、产品范围和阶段门禁，不替代各统计方法的数学规格。任何方法进入实现前，必须有单独评审的 versioned method spec，冻结公式、参数化、有效观测、Weight/Freq、缺失值、退化状态、数值算法、报告字段、黄金案例和容差。未冻结的方法不进入 capability registry，也不在 UI 显示。

当前版本实际交付范围、开发状态和人工验收状态以批准范围与验收台账为准。本文列出的长期目标不表示已批准进入当前版本。

## 2. 已批准决策

- 基准固定为 JMP Pro 19.0，覆盖全部四种建模类型。
- 采用混合交互：先显示角色启动对话框，运行后创建可保存的项目分析项。
- 角色包括一个或多个 Y，以及可选 Weight、Freq 和 By。
- 操作顺序、报告层级、菜单作用域和计算行为按黑盒基准验收；外观遵循 StatsPlayground。
- Distribution 负责统计计算及图表所需的结构化数值数据；Graph Builder 负责全部图形渲染、坐标轴、主题、交互和导出。
- 默认使用全量精确数据。仅 Graph Builder 的最终绘制点可以受控降采样，并明确标识；降采样不得改变 Distribution 统计结果或图表数据口径。
- 分阶段交付，每阶段形成可运行、可保存、可测试的纵向能力。
- `Save` 产生可重算公式列，不产生无来源的静态副本。
- 平台工具提供主程序原生等价能力，不实现 JSL。
- 共同建立脱敏黄金数据集和机器可读回归结果。
- 采用严格 clean-room 流程，并在发布前完成正式法律审查。
- 当前批准首版只交付连续描述能力和 Normal Process Capability；扩展摘要、Stem-and-leaf、equivalence、tolerance、高级拟合、zero-inflated、mixtures、情景分析和 Multiple Response 暂缓。
- Process Capability 默认读取 Table 列属性规格；手工规格只覆盖当前分析，不回写 Table。

## 3. 用户流程

### 3.1 启动

`Analyze > Distribution` 只在活动数据集存在且项目可修改时启用。启动对话框提供列搜索与选择、Y、Weight、Freq、By、Histograms Only、Remove、Recall、Run 和 Cancel。

Run 后创建 `Distribution N`，绑定源数据集并进入 Directory。分析项支持选择、重命名、移动、复制、删除、打开源表、报告导出和 `Edit Inputs`。编辑时载入当前配置；Cancel 不改变报告，Run 原子替换配置并启动新 revision。

源数据集或列缺失时保留分析项并进入可修复的 broken 状态，不静默删除。

### 3.2 报告层级

报告树按以下顺序生成：

1. By group，使用阶段 0 冻结的类型化稳定顺序。
2. Y variable，按启动角色顺序。
3. 统计报告块及可选 Graph Builder 图表块，按 capability registry 顺序。

By 排序必须明确数值、字符串、日期、声明的 value order、locale 和缺失值位置，不依赖 DuckDB 未声明的默认排序。

平台级菜单控制整份分析；变量级菜单控制一个 Y；报告块菜单只控制对应 block。动作使用稳定 capability ID，显示文字由本项目 i18n 提供。

### 3.3 持久化状态

保存角色绑定、建模类型、过滤、统计与拟合选项、置信水平、Graph Builder 图表配置引用、报告显示/折叠状态、名称、目录位置和公式定义。

不保存统计结果、绘图点、bootstrap 样本、优化中间状态和临时选择。项目打开后根据当前源数据重算。带 fingerprint 的公式列缓存可以用于快速显示，但验证失败必须重算。

## 4. 功能范围

### 4.1 连续变量默认统计与图表数据

- Quantiles、Summary Statistics 和 Stem-and-leaf 等统计结果。
- 全量精确 histogram bins/counts/probabilities。
- Tukey/quantile box 所需 quartiles、hinges、whiskers、outliers 和均值区间。
- ECDF/CDF、Q-Q、P-P 和拟合曲线所需结构化坐标及置信界。

Distribution 不生成 ECharts option，不拥有坐标轴、颜色、tooltip、缩放、平移、选择或图形导出。上述结构化数据通过稳定 chart-data contract 交给 Graph Builder 渲染。Graph Builder 不重新推导 quantiles、bins、whiskers、检验值或拟合参数。

### 4.2 摘要统计

目标集合包括 Mean、sample standard deviation、standard error、均值置信限、N、N Missing、Sum Weight、Sum、sample variance、bias-corrected skewness、excess kurtosis、coefficient of variation、N Zero、N Unique、uncorrected/corrected sums of squares、lag-1 autocorrelation、Minimum、Maximum、Median、Mode、trimmed mean、geometric mean、Range、IQR、MAD、Proportion Zero/Nonzero、Huber robust mean 和 robust standard deviation。

首版批准集合限于 Mean、sample standard deviation、standard error、均值置信限、N、N Missing、Minimum、Maximum、Median、Mode、Range、IQR 和 MAD。其余摘要统计保留为长期目标，当前暂缓。

阶段 0 必须先批准机器可读的《观测贡献语义表》，定义 `ObservationEligibility`、`WeightSemantics`、`FreqSemantics` 和 `ByMissingSemantics`。它至少覆盖有效行、逻辑样本量、N/N Missing/Sum Weight、统计分母、自由度、零/负/非有限值、缺失 By、Weight 与 Freq 同时存在以及 n=0/1/常数列。具体方法不能自行解释这些组合。

### 4.3 检验、区间与诊断数据

目标包括 Test Mean、Test Std Dev、Wilcoxon signed-rank、equivalence tests、mean/variance/proportion confidence intervals、prediction intervals 和 tolerance intervals。Normal Q-Q、通用 Q-Q、P-P 及适用置信界作为结构化诊断数据输出，由 Graph Builder 绘制。

Test block 必须包含估计值、原假设、统计量、参考分布、自由度、单尾/双尾 p 值、区间、状态、警告和方法脚注。

### 4.4 分布拟合与过程能力

目标注册表包括：

- Continuous：Normal、Cauchy、Student t、sinh-arcsinh、zero-inflated sinh-arcsinh、Exponential、Exponentially Modified Gaussian、Gamma、Lognormal、Weibull、smallest/largest extreme value、Johnson、Beta、two/three Normal mixtures 和 nonparametric density。
- Discrete：Poisson、Negative Binomial、zero-inflated Poisson、zero-inflated Negative Binomial、Binomial、Beta-Binomial、zero-inflated Binomial 和 zero-inflated Beta-Binomial。

每个分布在实现前必须冻结独立 method spec，包含 canonical parameterization、objective function、weighted likelihood、identifiability、initialization、constraints、optimizer/version、termination、standard-error method、failure states、determinism policy、PDF/PMF、CDF、inverse CDF、log-likelihood、AIC/AICc/BIC、拟合优度和容差。仅有名称不计入完成范围。

拟合优度目标包括适用的 Anderson-Darling、Shapiro-Wilk 和 Pearson chi-square。模拟 p 值必须使用版本化算法和确定性随机数流。Fit All 使用稳定排序。

Process Capability 支持 specification limits、拟合分布 quantile limits、K-sigma 单/双侧限制、Moving Range 和适用 normal/nonnormal capability 指标，并复用相同的分布参数化。

首版 Process Capability 只支持 Normal capability，并遵守以下规格来源规则：

- Table 列属性存在有效 LSL 或 USL 时自动生成 capability 报告。
- 列属性无有效规格边界时默认不生成；用户可在当前分析内手工输入有效 LSL 或 USL 后启用。
- 仅有 Target 不启用 capability。
- 手工值覆盖当前分析读取到的列属性值，随分析配置保存，但不回写 Table。
- 规格值必须是目标列单位下的有限数值；双侧规格满足 `LSL < USL`，Target 不得越过已提供的规格边界。无效列属性规格产生 warning 且不自动启用，无效手工规格阻止运行。
- 首版 Within Sigma 使用 average moving range；其他估计方法、nonnormal capability、K-sigma、quantile limits 和交互式情景分析暂缓。
- 首版输出范围、单侧语义、置信区间、超规比例和 PPM 以批准范围台账及独立 method spec 为准。

### 4.5 分类和多重响应

Nominal/Ordinal 报告至少包含 Level、Count、Probability、Probability Standard Error、Cumulative Probability、N Missing 和 N Unique。

Multiple Response 报告至少包含 Level、Count、Share of Responses、Rate Per Case、Total Cases、Total Responses、Levels、Empty、Responding、Single Item 和 Multiple Item。多重响应的源列编码、分隔、空项、重复项和 Weight/Freq 语义必须在阶段 4 method spec 中冻结。

当前版本暂缓 Nominal、Ordinal 和 Multiple Response；待连续变量能力完成自动测试和 UI 人工验收后重新评审。

### 4.6 Save 派生列

首版白名单覆盖 Level Numbers、Level Midpoints、Ranks、Average Ranks、Probability Scores、Normal Quantiles、Standardized、Centered、Robust Standardized 和 Robust Centered。

不建设通用用户公式语言，不接受任意 JavaScript、JSL、SQL 表达式或插件代码。

## 5. 运行时架构

采用四层边界：

1. **React Distribution Workspace**：启动对话框、统计报告树、菜单和显示状态。
2. **Typed IPC Contract**：capabilities、请求、结果、进度、取消和公式保存。
3. **Rust Statistics Kernel**：统计、区间、检验、拟合和 capability。
4. **DuckDB Data Executor**：元数据解析、过滤、By 分区、Weight/Freq 准备、基础聚合和有序数据流。
5. **Graph Builder Adapter**：将 Distribution 的 chart-data blocks 映射到主程序现有 Graph Builder/ECharts 渲染与交互，不执行统计推导。

React 不重新计算统计量。DuckDB 原生函数只有在公式、参数化、边界和缺失语义经 method spec 与黄金结果确认后才能使用。

### 5.1 请求和过滤

`DistributionRequest` 至少包含 analysis ID、config revision、run ID、dataset ID、Y 及建模类型、Weight/Freq/By、FilterExpr、平台/变量选项、资源预算和 exact 模式。

所有列先从元数据解析；前端不能传 SQL、表名、函数名或表达式片段。

过滤使用版本化 `FilterExpr` AST，只允许稳定 column ID 和类型化的 `and`、`or`、`not`、null、数值范围、类别集合和日期范围谓词。阶段 0 冻结其与现有过滤模型的转换边界、空表达式、日期时区、字符串比较、序列化和 DuckDB 编译语义。

### 5.2 结果和报告块

`DistributionResult` 至少包含 analysis ID、config revision、run ID、source data version、exact、provenance、运行统计、By groups、变量报告树、chart-data blocks、warnings 和公式保存 capabilities。

报告块采用 discriminated union。公共外壳包含稳定 ID、kind、i18n title key、显示/折叠能力、菜单 capabilities、状态和专用 payload。统计类型包括 quantiles table、summary table、test、interval、distribution fit 和 frequency table。图表数据类型包括 histogram data、box-plot data、Q-Q/P-P data、CDF data、fitted-curve data 和 diagnostic-coordinate data。

`exact` 仅表示统计计算未使用近似算法。Distribution chart-data blocks 也是全量精确计算结果；Graph Builder 若为显示性能简化绘制点，使用自身独立 sampling metadata。Provenance 至少包含 method/registry version、snapshot ID、schema/filter/parameter hashes、随机种子策略、平台和 build ID。

### 5.3 快照、取消与错误

每次运行开始时，后端创建不可变 `AnalysisSnapshot`，包含 snapshot ID、参与数据集 generation、column schema fingerprint 和 filter hash。所有报告块只读取该 snapshot；无法建立一致性边界时整个运行失败。

`analysisId`、`configRevision`、`runId` 和 `sourceDataVersion` 是不同字段。提交结果时验证该四元组仍有效。旧任务尽早取消；不能中断的旧结果必须丢弃。新结果完成前保留旧有效报告并显示更新状态。

单个块因样本量、定义域或常数列不可用时返回局部 `unavailable` 和原因。数据源/列不存在、角色非法、数据库失败、stale snapshot 或资源预算超限属于全局失败，不清空旧报告。

并发测试必须在运行期间修改源表，验证报告块不跨 snapshot、不同 revision 不交叉。生产 Rust 返回 `Result<T, AppError>`，不使用 `unwrap()` 或 `expect()`。

## 6. 数学兼容规则

每个 method 同时满足：

1. 公式：偏差修正、分母、quantile 类型、区间和 Weight/Freq 规则。
2. 算法：初值、约束、优化、终止、bootstrap 和 exact/asymptotic 路径。
3. 报告：默认项、DF、尾部、警告、不可用条件和排序。
4. 回归：黄金字段、容差、确定性和跨平台结果。

Distribution quantile 基线使用 Hyndman-Fan Type 6：对非缺失排序样本使用 $r=(n+1)p$，执行边界截断及线性插值。当前 DuckDB `QUANTILE_CONT` 是 Type 7，不得用于该兼容路径。

`quantile.type6`、`boxplot.tukey`、`boxplot.quantile` 和 `histogram` 是独立 calculation method ID。箱线图规格另行冻结 hinge、whisker、outlier threshold、Weight/Freq、空组/单值组和结构化坐标。Histogram 规格另行冻结 bin width/count、edge inclusion、空 bin、归一化和 By 共享规则；bin 统计永远基于全量逻辑数据。Graph Builder 只消费这些结果，不重新计算。

可以采用经许可证审计的 Rust crate 作为分布函数、矩阵、优化和随机数原语，但第三方默认 quantile、moments、MLE、optimizer tolerance 或检验不能直接视为兼容实现。

## 7. 可重算公式列

公式列使用版本化白名单 AST，包含 formula ID/version、稳定 source column IDs、By/Weight/Freq 上下文、类型化参数、输出类型和缺失策略。禁止保存代码字符串。

公式定义属于项目级派生定义，并显式映射到目标 dataset 的 materialization 状态。数据提交后按依赖图标记 dirty 并异步重算；列重命名不破坏稳定 ID；源列删除进入 broken 状态；循环依赖在保存前拒绝；执行使用拓扑排序。

阶段 5 method spec 必须冻结稳定列 ID 的生成、复制/导入重绑定、列删除事件、缓存失效、失败重算和用户可见状态。

## 8. 项目格式

Project manifest 正式新增：

- `distributions: []`
- `distributionFolders: {}`
- `derivedFormulas: []`

Distribution 定义内联 manifest。每项至少包含稳定 analysis ID、名称、source dataset ID、创建时间、config schema/version、当前配置和显示状态，不保存运行结果。目录映射使用 `analysisId -> folderPath`。公式定义是独立 versioned AST 集合，并引用创建它的分析项。

项目 manifest 与公式 AST 分别版本化。未知关键版本不静默降级，保留原始定义并以只读/不可用状态展示。只有破坏性格式变化才提升 SPPRJ 主版本。

阶段 0 同步扩展 `open_project`、`save_project`、Rust/TS model、service、store 和 Directory，并覆盖旧项目迁移、未知字段、损坏条目和缺失源数据的 round-trip 测试。

## 9. 性能、安全与资源

- 同一变量的 histogram、quantiles、boxplot 和 ECDF 共享扫描与排序结果。
- 拟合共享充分统计量或有序样本，不为每个 block 重复拉取全列。
- Freq 使用逻辑频数算法，不物理展开重复行。
- 运行前估算 groups × variables × fits × bootstrap 工作量。
- 长任务提供进度、取消、内存/时间预算和明确失败。
- 不得自动将 exact 改为 approximate。
- Graph Builder 绘图抽样不影响表格、参数、检验、区间、bin、box、Q-Q/P-P 或 CDF 数据。
- SQL 只由后端白名单模板及安全 identifier quoting 生成；数值参数使用 binding 或严格校验。
- 文件读写经 Tauri dialog 和允许目录校验，绝对路径不进入前端或项目。
- 未知 schema、算法版本和资源超限显式失败。

## 10. Clean-room 与知识产权控制

### 10.1 法律边界

本节只定义内部风险控制，不判断任何资料、依赖、算法、专利、商标、网站条款或 clean-room 安排的法律效果。进入公开发布或商业分发前，必须由指定法律顾问书面审查 JMP EULA、网站条款、专利、商标和目标司法辖区要求。产品负责人不能批准法律例外。

JMP/SAS 网站材料标注保留全部权利，其公开网站条款还对将网站材料用于竞争产品开发设置限制。实现团队不得把 JMP 在线帮助作为需求或实现资料来源。

### 10.2 资料白名单

- 公有领域或许可明确的统计论文、标准和教科书公式。
- 经确认与项目分发方式兼容的开源库及文档，保留必要 NOTICE/attribution。
- 团队独立编写的需求、schema 和测试输入。
- 经受控流程导出的纯黑盒事实。

### 10.3 禁止行为

- 不复制、改写或存储 JMP 帮助正文、截图、图标、声音、示例数据或界面素材。
- 不反编译、反汇编、hook、抓取或分析 JMP 可执行文件、安装目录、私有协议或 JSL 实现。
- 不使用 NDA、登录限制、合作伙伴区域或其他非公开资料。
- 不把本次会话附件或浏览器调研内容提交到仓库、源码注释、测试、issue 或产品文案。
- 不使用 JMP 名称、标志或独特视觉资产作为品牌，也不暗示赞助、附属或认证。
- 不宣称“JMP 官方”“JMP certified”或“完全相同”。对外描述性兼容声明必须经律师批准并附无隶属关系说明。

### 10.4 角色隔离和数据通道

- **Reference/validation role** 仅在法律顾问确认的许可边界内操作 JMP，原始记录只进入隔离 validation repository。
- **Implementation role** 只接收公开统计来源、独立需求和经批准的规范化黑盒数据，不访问 JMP 软件或 JMP/SAS 网站材料。
- **Clean-room steward** 用版本化工具验证 `BlackBoxCase` schema，删除产品文本、截图、JSL 和非必要 provenance，再导出实现 fixture。

每次导出记录 case ID、提交者、审查者、工具版本、允许字段、输入/输出 hash 和法律审查状态。Implementation role 只能读取批准后的只读导出目录。原始资产不进入产品仓库、CI artifact 或 issue。

`BlackBoxCase` 只允许自有/脱敏输入、抽象 action ID、类型化参数、数值/枚举/状态输出、允许的 warning code 和必要 provenance；禁止自由文本产品输出。Validation repository 不随 Apache-2.0 产品发布。

人员隔离范围、接触记录和例外由组织政策及法律顾问书面意见定义。本设计会话已接触 JMP 帮助与截图，因此本会话代理不得执行相关统计内核实现。

### 10.5 专利、商标和依赖检查点

- 分布拟合、过程能力、特殊检验和交互工作流在实现前完成专利检索及律师复核。
- 依赖引入前审计许可证、NOTICE、专利条款和出口限制。
- 发布前审查产品名称、兼容声明、商店描述、截图和文档，避免来源混淆。

## 11. 测试与验收

### 11.1 基础设施

阶段 0 固定 Rust unit/property tests、前端 test runner、Tauri/UI 自动化、版本化黄金 fixture runner、随机种子、artifact 格式和 Windows/macOS/Linux CI 矩阵及命令。

### 11.2 黄金矩阵

覆盖空数据、n=1/2、小样本、常数、重复、偏态、重尾、多峰、零膨胀、缺失、Weight、Freq、By、过滤、检测限、极端量级、近零方差和概率边界。

每个拟合覆盖合成数据、固定参数、失败收敛和分数并列。图表验收分两层：Distribution 验证结构化 chart-data 数值，Graph Builder 验证渲染与交互。截图只用于隔离的人工 UI 验收，不进入公开仓库。

### 11.3 完成门槛

每个 method 必须同时满足：

- 公开算法来源和参数化完整。
- Rust unit/property tests 通过。
- 脱敏黄金结果在预先定义的 absolute/relative/ULP 容差内。
- UI 字段、状态、警告和交互测试通过。
- 前端 build、Rust build/clippy/test 和跨平台 CI 通过。
- 来源台账及依赖许可证审计通过。
- 产品负责人在 StatsPlayground 正式界面中完成真实用户流程验收，并在批准范围台账中将对应 `uiAcceptance` 更新为 `passed`。

最终验收包包含覆盖矩阵、公开来源、黄金输入/输出、自动回归、容差、UI 清单、跨平台记录和差异矩阵。差异必须记录原因、影响、回归案例、产品批准和法律审查状态；产品批准不等同于法律批准。

## 12. 分阶段交付

### 阶段 0：契约与合规基础

冻结 IPC、manifest、AnalysisSnapshot、FilterExpr、观测贡献语义表、By 排序、错误 schema、capability registry、method spec 模板、测试基础设施、来源台账和 clean-room export 流程。通过最小分析的 save/open、snapshot concurrency、IPC contract、旧项目迁移和 validation schema 测试。

### 阶段 1：平台骨架与连续描述

交付启动角色、项目分析项、By/Weight/Freq、批准的 quantiles 与 summary，以及 histogram/box/ECDF 的结构化 chart-data；统计结果和 chart-data 通过黄金对照，图形由 Graph Builder 渲染。Stem-and-leaf 当前暂缓。

### 阶段 2：连续推断

连续描述能力验收后重新评审 mean/std-dev tests、confidence/prediction intervals 和 Q-Q/P-P 诊断数据。Equivalence tests 与 tolerance intervals 当前暂缓。

### 阶段 3：分布拟合与过程能力

先交付批准的 Normal Process Capability：规格限读取/覆盖、Within/Overall 指标、置信区间、超规比例、PPM 和结构化图表数据。通用拟合 UI、离散拟合、Fit All、高级拟合、zero-inflated、mixtures 和 nonnormal capability 当前暂缓。

### 阶段 4：分类与多重响应

Nominal、Ordinal 和 Multiple Response 当前暂缓；连续变量功能稳定并完成人工验收后再决定交付范围。

### 阶段 5：公式列与平台等价工具

交付 Save 白名单公式、依赖重算、Local Filter、重做/重算和报告导出；源数据变化后公式列与分析按同一语义重算，并完成端到端人工验收。

## 13. 明确不做

- JMP/JSL 源码、语言或脚本兼容。
- JMP 像素级视觉复刻、商标、图标、截图或帮助文本复制。
- 独立于 Graph Builder 的 Distribution 图表引擎、ECharts 配置系统或图形交互栈。
- 任意用户代码或 SQL 公式执行。
- 无标识近似统计。
- 未经律师审查的认证、隶属或官方兼容声明。
