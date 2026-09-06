# Fit Model 回归分析设计

**日期：** 2026-09-01

**状态：** 已批准

**Issue：** #83

**来源实现：** `C:\Users\xumax\AI Project\sixsigmacopilot\sixsigma-mvp`

## 1. 背景

StatsPlayground 已通过 Fit Y by X 建立分析文档、项目树集成、Rust 统计服务、
Tauri IPC、请求 generation fencing 和 JMP 风格报告的完整链路，但现有
Bivariate personality 只支持一个连续 X 的一阶线性拟合。

sixsigmacopilot 已实现连续响应的简单和多元线性回归，并支持主效应、两因子
交互、强层级、交互项中心化、Effect Summary、Actual by Predicted、Residual
by Predicted、单点预测和 Prediction Profiler。

本功能采用“语义镜像、原生重写”：保留 sixsigmacopilot 的模型定义、统计口径、
结果语义与测试基准，按照 StatsPlayground 的 Rust + Tauri + Zustand + React
架构重新实现。不得复制其 FastAPI、Pydantic、SQLAlchemy 或页面状态结构。

## 2. 首期目标

在 Analyze 菜单中增加 Fit Model。用户可以针对活动数据表：

1. 选择一个连续字段作为 `Y, Response`；
2. 选择一个或多个连续字段作为主效应；
3. 添加满足强层级的两因子交互项；
4. 应用 `Factorial to Degree 1/2` 模型宏；
5. 对交互项选择不中心化或均值中心化；
6. 创建可保存、重开和管理的 `Fit Model N` 分析文档；
7. 查看 Summary of Fit、Analysis of Variance、Parameter Estimates、Effect
   Summary、Actual by Predicted 和 Residual by Predicted；
8. 从 Effect Summary 移除效应并重新拟合，在当前会话中支持一步撤销。

首期只实现带截距的普通最小二乘线性模型。所有权威统计结果使用全量有效数据
在 Rust 后端计算，不从图表采样数据或前端显示值推导。

## 3. 非目标

- 单点 Prediction 和 Prediction Profiler；它们作为第二阶段独立设计；
- 分类预测变量的 indicator coding；
- Logistic、GLM、多响应、权重、offset 或无截距模型；
- 平方项、三阶及以上交互、任意多项式；
- Stepwise、自动按 p-value 删除、模型比较历史；
- VIF、Cook's Distance、杠杆图、QQ 图、残差正态性检验；
- DOE pure error、curvature 和 lack-of-fit 分解；
- 持久化计算结果、逐行拟合值或图表数据；
- 对 JMP 或 sixsigmacopilot 做像素级复制；
- 在本 Issue 中引入通用 Workspace document registry。

sixsigmacopilot 的旧 OpenAPI 文档曾列出 polynomial、diagnostics、normality、
FDR 等选项，但其运行时未实现，因此不作为本次镜像范围。

## 4. 方案选择

### 4.1 采用：Rust 原生统计内核

Fit Model 使用专用 Rust 服务实现模型项规范化、设计矩阵、秩判断、OLS 和统计
推断。`statrs` 提供 t 分布和 F 分布；新增 `nalgebra` 用于 QR/SVD 等线性代数
计算。

相较于直接照搬 $(X^T X)^{-1}X^Ty$，QR/SVD 对病态矩阵更稳定，并能提供明确
的秩判断。不得把矩阵求逆作为默认求解路径。

### 4.2 拒绝：嵌入 Python/FastAPI

该方案会引入额外运行时、进程通信、打包和跨平台部署复杂度，并绕过项目既有
Tauri IPC 边界。

### 4.3 拒绝：前端 TypeScript 计算

该方案会让统计权威性依赖浏览器状态，并容易错误使用图表采样数据，不符合
Fit Y by X 已建立的后端全量计算原则。

## 5. 总体架构

```text
FitModelItem（持久化定义）
  |-- FitModelRoleDialog -> useFitModelStore -> project manifest
  |
  `-- FitModelRequest
        -> fit_model Tauri command
        -> FitModelService
        -> validated multi-column DuckDB reader
        -> term resolver / ModelMatrixSpec
        -> Rust OLS engine
        -> FitModelResult
             |-- statistical report
             |-- Effect Summary
             |-- Actual by Predicted
             `-- Residual by Predicted
```

分析定义和计算结果分离：Zustand 与项目文件只保存可复现模型的输入定义；报告
hook 根据当前 dataset generation 请求结果。切换文档、源数据变化或组件卸载时，
旧请求不得覆盖当前结果。

## 6. 分析文档模型

前端增加以下持久化语义：

```ts
type FitModelCenteringMethod = "none" | "mean";

interface FitModelTerm {
  kind: "main" | "interaction";
  columnNames: string[];
}

interface FitModelItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  response: FieldRef;
  terms: FitModelTerm[];
  centeringMethod: FitModelCenteringMethod;
  createdAt: string;
}
```

StatsPlayground 当前没有跨重命名稳定的 column UUID，`FieldRef` 和 Fit Y by X
均以列名标识字段，因此首期沿用 `FieldRef.name`/`columnNames`，不在本 Issue 中
引入全局 column identity 迁移。源列重命名后旧引用找不到精确列名时，分析进入
unavailable 状态；不得按位置或相似名称静默重新绑定。

约束：

- `main` 必须包含一个列名；
- `interaction` 必须包含两个不同的列名；
- 交互项列名按稳定规则排序，因此 `A*B` 与 `B*A` 是同一项；
- 每个交互项引用的两个主效应必须同时存在；
- response 不得出现在任何模型项中；
- response 与所有模型字段必须是 continuous；
- 模型至少包含一个主效应；
- 截距固定包含，不作为可编辑 term 保存；
- `mean` 只中心化交互项的参与值，主效应列仍保持原始尺度；
- disclosure 展开状态只属于当前 `FitModelView` 会话，不进入 `FitModelItem` 或
  project manifest，重新打开项目时使用默认展开状态。

项目加载时必须重新验证并规范化 terms。无效分析应隔离为 unavailable 状态，
不得使整个项目打开失败。旧项目缺少 Fit Model 字段时加载为空集合。

## 7. 角色与模型配置体验

Analyze > Fit Model 仅在存在活动数据表且项目可修改时启用。对话框遵循现有
Fit Y by X 的字段列表、搜索、拖放、键盘操作、建模类型图标和校验反馈风格。

对话框包含：

- `Y, Response` 单值槽位；
- `Construct Model Effects` 区域；
- Main Effects 列表；
- Interactions 列表；
- `Macros` 中的 `Factorial to Degree` 与 Degree 1/2；
- 仅在存在交互项时显示的 Center Interactions 选项；
- Current Model Terms；
- Model Size，在创建前只显示可由草稿确定的参数数 $p$；
- Create 和 Cancel。

前端没有全量数据，因此对话框不预估 complete-case 行数或 residual degrees of
freedom。正式拟合完成后，Summary of Fit 显示 $n$ 和 residual df。

Degree 1 宏生成所有已选连续预测变量的主效应。Degree 2 在 Degree 1 基础上
生成所有两两交互。宏只更新草稿，不自动运行分析。

删除被交互项引用的主效应时必须阻止操作并列出依赖交互项，不得静默级联。
删除交互项不影响主效应。选择 response 时，如果该字段已在模型中使用，也必须
阻止并给出可操作反馈。

## 8. Workspace 与项目生命周期

Fit Model 作为独立文档族接入 Workspace：

- 创建后加入项目树并自动选中；
- 支持选择、重命名、删除、右键菜单和拖入文件夹；
- 支持 read-only 项目查看，所有变更调用 `assertProjectMutable`；
- 删除源数据表时级联删除其 Fit Model 文档；
- close/reset 清空 store；
- save/open 恢复分析定义、文件夹位置和默认名称计数器；
- 新增 `fitModels` 与 `fitModelFolders` manifest 字段；
- Rust archive 层把 payload 作为 opaque JSON 保存，并清除任何意外的 transient
  result 字段。

首期沿用当前显式接入方式，不重构所有 Workspace 文档类型。仅在新增重复代码会
直接造成错误风险时提取局部 helper。

## 9. IPC 契约

请求只携带可重算定义：

```ts
interface FitModelRequest {
  datasetId: string;
  generation: number;
  responseColumn: string;
  terms: FitModelTerm[];
  centeringMethod: "none" | "mean";
  confidenceLevel: number;
}
```

结果使用明确的判别联合：

```ts
type FitModelResult = FitModelFittedResult | FitModelNotComputableResult;

interface FitModelFittedResult {
  kind: "fitted";
  usedRows: number;
  excludedRows: number;
  plotRows: FitModelPlotRow[];
  plotRowsSampled: boolean;
  warnings: FitModelWarningCode[];
  // fit、ANOVA、parameters、terms、centering 等结构化字段
}

interface FitModelNotComputableResult {
  kind: "notComputable";
  reason: "insufficientRows" | "rankDeficient";
  usedRows: number;
  excludedRows: number;
}
```

`n < p` 返回 `insufficientRows`；`rank < p` 返回 `rankDeficient`。饱和模型、
常量 response 和完美拟合仍返回 `fitted`：饱和模型保留系数与拟合值但推断字段
为 `null`；常量 response 的 $R^2$/F 相关字段为 `null`；完美拟合的未定义检验
字段为 `null`。这些状态通过稳定 warning code 说明。

fitted 结果包含：

- response 与 predictor references；
- 结构化 model terms；
- 格式化方程所需的原始系数和 term labels；
- Parameter Estimates；
- Model、Error、Total 三行 ANOVA；
- $R^2$、Adjusted $R^2$、RMSE、N、model df、error df；
- 最多 8,000 个确定性采样诊断点的 observed、fitted、residual 和 row index；
- 交互中心常数；
- used/excluded row counts；
- warnings；
- expected degeneracy 的稳定 reason code。

Rust models 使用 `#[serde(rename_all = "camelCase")]`，TypeScript 类型逐字段镜像。
命令只负责从 `State<AppState>` 构造 service 并委托。命令必须注册到
`tauri::generate_handler!`，前端通过独立 `fitModelService` 的 `invoke<T>()` 调用。

## 10. 数据读取与预处理

DuckDB engine 增加受验证的多列读取接口：

1. 验证 dataset ID、generation 和所有列名；
2. 验证 response 与每个源 predictor 列名、物理类型和 modeling type；
3. 只在验证后使用项目现有 identifier quoting 路径；
4. 使用一次查询读取 response 与所有 terms 引用的唯一源列；
5. 在后端拟合期间保留原始 row index；
6. 对 response 和所有模型源列执行 listwise complete-case 删除；
7. 排除 null、非数值、NaN 和 infinite；
8. 返回 used/excluded 数量，首期不把完整 excluded index 列表传到前端。

交互项不增加缺失值检查列，因为其参与字段已由强层级对应的主效应覆盖。均值
中心常数只能基于最终 complete-case 行计算。

拟合必须使用全部 complete-case 行。仅 IPC 诊断 payload 采用与 Graph Builder
一致的 `GRAPH_SCATTER_RENDER_BUDGET = 8_000`：当有效行超过预算时，后端按
原始 row index 做确定性等距/rank-grid 采样，并设置 `plotRowsSampled=true`。
因此 ECharts progressive 只负责绘制，IPC 不传输无上限的逐行对象。

## 11. 模型项和设计矩阵

后端 term resolver 是 persisted/request term 的唯一权威规范化入口，负责：

- 校验 term arity 和 column 唯一性；
- canonicalize interaction identity；
- 保持确定性顺序；
- 强层级校验；
- 生成稳定 `termId` 和 display label；
- 计算设计矩阵列顺序。

`ModelMatrixSpec` 是拟合与未来 Prediction/Profiler 复用的不可变规范：

```text
[Intercept, main effects..., interactions...]
```

`none` 使用原始乘积 $AB$；`mean` 使用
$(A-\bar A)(B-\bar B)$，但主效应列仍为 $A$ 和 $B$。完整精度中心常数返回在
结构化结果中，格式化方程不是重建模型的权威来源。

实时创建/IPC 请求采用严格校验：重复主效应以及规范化后重复的 `A*B`/`B*A`
返回 `duplicateTerm`。项目加载 normalizer 可规范化顺序并保留第一项、删除后续
重复项，同时产生会话级 migration warning；严格请求校验不得静默去重。

## 12. OLS 与统计定义

设有效行数为 $n$，设计矩阵列数为 $p$。先通过 SVD 判断数值秩，再使用稳定分解
求解系数。检查顺序固定为：先判断 $n < p$，再计算 SVD rank；满秩后才计算
condition number 和拟合统计。

冻结以下数值标准：

- SVD rank tolerance：$\max(n,p)\,\epsilon\,\sigma_{max}$；
- condition number 大于 $10^{10}$ 返回 `illConditioned` warning；
- perfect fit：`SSE == 0`，或 `SST > 0` 且
  $SSE \le 10^{-12}SST$；
- 因浮点误差落入 $10^{-12}\max(SST,1)$ 范围内的负 SSE/SSM 截断为 0，超过
  该范围视为数值错误；
- 数值 oracle 默认 `rtol = 1e-9`、`atol = 1e-12`，分布尾部另以固定 fixture
  的绝对误差断言；
- p-value 显示下限为 $10^{-300}$，Effect Summary 的 LogWorth 显示上限为 300。

- `rank < p`：返回 `rankDeficient`，不生成伪唯一系数；
- condition number 超过 $10^{10}$：仍计算，但返回 `illConditioned` warning；
- `n < p`：返回 `insufficientRows`；
- `n = p`：允许饱和模型，系数和拟合值可用，推断字段为 `null`；
- `n > p`：计算完整推断。

核心统计：

$$
SSE = \sum_i (y_i-\hat y_i)^2,
\quad SST = \sum_i (y_i-\bar y)^2,
\quad SSM = SST-SSE
$$

$$
R^2 = 1-\frac{SSE}{SST},
\quad R^2_{adj}=1-\frac{SSE/(n-p)}{SST/(n-1)}
$$

参数标准误来自 $MSE(X^TX)^{-1}$ 的对角线，但实现应通过选定分解求逆/求解，
不得重新采用普通矩阵逆作为系数求解器。参数检验为双侧 t-test，整体模型检验为
F-test，置信水平默认 0.95。

完美拟合使用相对 SSE 容差判断。无法定义的 t、F、p-value、标准误、置信区间、
Adjusted $R^2$ 或 RMSE 必须返回 `null`，不得序列化 NaN 或 Infinity。

## 13. 报告与诊断视图

`FitModelView` 使用垂直可滚动的 JMP 风格报告。标题区显示分析名、源表、Y 和
模型项数量；各结果区使用现有 disclosure bar，不嵌套卡片。

报告顺序：

1. Effect Summary；
2. Summary of Fit；
3. Analysis of Variance；
4. Parameter Estimates；
5. Actual by Predicted；
6. Residual by Predicted；
7. Warnings。

Effect Summary 对每个连续一自由度 term 使用当前参数化下系数双侧 t-test 的
p-value；该值等价于一自由度 partial F。交互中心化可能改变参与交互的主效应
检验，但不改变 fitted values、整体 ANOVA 或交互项检验。结果按
$LogWorth=-\log_{10}(p)$ 降序排列；`p=null` 排在末尾并显示不可用，p-value 为
零或低于 $10^{-300}$ 时显示 LogWorth 300，不把 Infinity 交给 ECharts。每一项
提供 Remove 操作；移除主效应受强层级约束，成功移除后重新请求模型，并允许
一次 Undo。

Actual by Predicted 显示 $(\hat y_i,y_i)$ 散点和 $y=x$ 参考线。Residual by
Predicted 显示 $(\hat y_i,e_i)$ 散点和 $y=0$ 参考线。两图由分析专属 adapter
把后端 row fits 转为 ECharts option；不为这些派生值创建隐藏数据列，也不经过
Graph Builder graph-data 请求。

图表 loading/error 与统计报告共享一次 Fit Model 请求，但局部渲染失败不得删除
分析定义。图表需要响应式稳定尺寸、tooltip、轴标题和大数据散点 progressive
配置，并遵循 StatsPlayground 现有 ECharts theme。

## 14. 并发与错误处理

报告 controller 捕获 item ID、dataset ID、dataset generation、本地 request token
和稳定 `configurationKey`。key 由 response、canonical terms、centering method、
confidence level 和 generation 构成。后端获取数据库锁后、读取数据前验证
generation；前端提交响应前必须同时核对 token 与 configurationKey。配置变化时
旧报告保留但标记为 stale，直到新请求成功；新请求失败时显示错误并保留旧报告
供比较，不得把旧报告标记为当前模型结果。

错误分为：

- `AppError::InvalidParam`：非法置信水平、字段、建模类型或 term；
- `AppError::Database`：DuckDB 读取失败；
- result reason code：`insufficientRows`、`rankDeficient` 等无法产生唯一拟合的
  预期状态；
- warnings：`saturatedModel`、`constantResponse`、`perfectFit`、
  `illConditioned` 等仍可展示部分结果的状态。

所有 reason code 和 warning code 在前端本地化。Rust 非测试代码不得使用
`unwrap()` 或 `expect()`。

## 15. 测试策略

实现遵循 red-green-refactor，每个边界先写聚焦失败测试。

### 15.1 前端纯函数与状态

- response/main/interaction 角色校验；
- interaction canonicalization、去重和强层级；
- Degree 1/2 宏；
- model parameter count；
- store CRUD、read-only guard、默认名称和 source cascade；
- malformed/legacy project normalization；
- folder movement 和 project save/open；
- request generation fencing 和 stale response；
- Effect Summary 排序、Remove & Refit 和 Undo；
- null/degenerate/error/warning 报告状态；
- Analyze 菜单与 Workspace 生命周期；
- 中英文及现有其他 locale key 完整性。

### 15.2 Rust 数值与服务

从 sixsigmacopilot 移植固定 fixtures：

- exact/noisy simple line；
- exact/noisy multiple plane；
- replicated $2^2$ interaction；
- mean-centered interaction；
- complete-case exclusion；
- perfect fit；
- saturated full-rank model；
- rank-deficient model；
- constant response；
- ill-conditioned model。

使用独立 oracle 固化 coefficients、SSE、ANOVA、$R^2$、Adjusted $R^2$、RMSE、
标准误、t/F 和 p-value。测试同时验证 $SST=SSM+SSE$、residual sum 接近零、
中心化不改变 fitted values 等恒等式。

模型、service、command 和 IPC serialization 均有局部测试；DuckDB reader 测试
覆盖 generation race、字段验证、listwise deletion 和 row index 保留。

### 15.3 图表与验收

- adapter 输出有限数值和确定性 ECharts option；
- 超过 8,000 个有效行时只传输确定性诊断样本，统计结果仍使用全量行；
- reference line、tooltip、axis name 和空/单点状态；
- 桌面与窄视口无重叠，报告标题可达；
- Tauri 中创建、切换、重命名、移动、删除和 save/reopen；
- 与同一 fixtures 的 sixsigmacopilot/JMP 参考结果人工比对。

最终执行：

```powershell
npx tsc -b
npx vite build
cargo test
cargo clippy -- -D warnings
```

## 16. 分阶段交付

1. **模型定义：** TypeScript/Rust contract、terms、角色校验、模型宏；
2. **文档生命周期：** store、Workspace、项目树、文件夹、archive；
3. **统计内核：** 多列 reader、ModelMatrixSpec、SVD/QR、OLS 与 oracle；
4. **端到端请求：** command、service wrapper、report controller、generation fencing；
5. **报告：** Fit/ANOVA/Parameters/Effect Summary；
6. **诊断：** Actual by Predicted、Residual by Predicted、确定性采样；
7. **验收：** 全量前后端测试、clippy、build 和 Tauri 手工验证；
8. **后续阶段：** 基于同一 ModelMatrixSpec 增加 Prediction 和 Profiler。

每个阶段应保持可构建、可测试，并使用独立 conventional commit，避免一次提交
混合统计内核、项目持久化和 UI。

## 17. 完成标准

当且仅当以下条件全部满足时，Issue #83 首期完成：

1. Analyze > Fit Model 可创建符合约束的分析文档；
2. 项目树与 save/open 生命周期与 Fit Y by X 一致；
3. Rust 对主效应、两因子交互和交互中心化给出可信 OLS 结果；
4. 报告完整显示指定表格、Effect Summary 和两张诊断图；
5. 缺失值、秩亏、饱和、完美拟合和病态矩阵均有确定性行为；
6. 不持久化统计结果，不使用采样图表数据计算统计量；
7. sixsigmacopilot 固定 fixtures 与独立 oracle 在第 12 节冻结的容差内一致；
8. 前端 build、Rust tests 和 clippy 全部通过；
9. Tauri 手工验收覆盖创建、快速切换、Remove & Refit、Undo 和 save/reopen。