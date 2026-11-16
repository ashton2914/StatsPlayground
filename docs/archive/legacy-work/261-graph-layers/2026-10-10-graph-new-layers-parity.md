# Graph Builder-new Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新版 Scatter 与 Line 使用旧版独立图层体验，并补齐设置的实际绘图和项目持久化行为。

**Architecture:** 共用旧版选项编辑器，使用 v3 类型化图层列表替代全局 rawMode/showMean。Rust 在完整源数据上计算汇总、区间、缺失规则和路径，wgpu 统一绘制各层；WebView 保留已有轴文字、帧与相机流程。v1/v2 在内存迁移为保持原画面的独立图层。

**Tech Stack:** React、TypeScript、Zustand、Tauri、Rust、wgpu、Playwright CT。

**Spec:** [已确认设计](../specs/2026-10-10-graph-new-layers-parity-design.md)

## Global Constraints

- 在既有 `261-graph-zoom-ux` 工作树实施，基线 `5df942c`；保留已有源文件变更，不另建工作树。
- 继续使用新版 Rust/wgpu 渲染、数据缓存、Overlay 和相机流程。
- 此次不增加 Bar、Smoother、Fit Line 等其他图形元素，不扩展右侧 STYLE 功能，也不修改旧版的统计算法。
- 新建 Scatter 默认 None / Auto / Error Bar / Stacked / 0.5；新建 Line 默认 Row order 关 / Line / Mean / None / Auto / Error Bar / Skip / Connect Through。
- 删除最后一层显示添加图层提示，缺少 X 或 Y 时继续显示旧版 `graph.dragHint`。
- 统计结果以完整来源的合法观测值为依据，不能使用 LOD 代表点计算。
- 拖动、缩放和相机恢复不得触发来源重扫；所有派生准备可取消并遵守 CPU/GPU/磁盘预算。
- 保留旧项目画面，打开不标脏，下次正常保存输出 v3；只读禁止图层修改。
- 按任务执行红—绿测试，最终独立代码审查和桌面验收。提交、推送和创建 PR 仍需对应用户授权；本计划不自动执行 Git 发布操作。

## Review Focus

1. v2 同时保存 raw line 与 Mean：两条线均恢复，不能合并丢失；由 Task 2 固定测试。
2. 缺失 Y 在过滤后丢失断点：Break 必须断开、Connect 才跨越；由 Task 4 固定测试。
3. 极端值与 Sum 超出原始 Y 域：无无穷 GPU 坐标，Reset 覆盖有效汇总区间；由 Task 3/5 固定测试。
4. 快速设置变更、保存锁定和来源替换并发：旧派生帧不能覆盖新配置，保存期间不能晚写图层；由 Task 5 固定测试。
5. 移动宽度与旧项目多 Line 卡片：每个控件操作正确图层，标签不截断至无法理解；由 Task 6 固定测试。

## 文件与接口约定

`src/components/graphBuilder/shared/GraphLayerOptions.tsx` 负责旧版/新版共用编辑器；`src/components/graphBuilder/shared/graphLayerOptions.ts` 定义枚举、默认值及归一化。旧版 `GraphBuilderView.tsx` 仅提取 PointsOptions/LineOptions 及其必要表单行，不拆其他编辑器。

`src/types/graphBuilderNew.ts` 定义 v3 文档与图层联合类型；`src/components/graphBuilderNew/graphNewLayers.ts` 负责新建、校验及迁移。`useGraphBuilderNewStore.ts` 管理文档与会话，`GraphBuilderNewLayers.tsx` 管理图层卡片及添加入口。

Rust 新模块 `src-tauri/src/services/graph_new_layers.rs` 管理图层计算及几何，`graph_new_layers_cache.rs` 管理派生缓存；其余已有源缓存、renderer、service 和 transport 按需扩展。模块在 `src-tauri/src/services/mod.rs` 注册。

图层类型固定为 `GraphNewLayer = { id: string; kind: "points"; options: GraphPointOptions } | { id: string; kind: "line"; options: GraphLineOptions } | { id: string; kind: "timeSeries"; options: GraphLineOptions }`。timeSeries 显式表示旧项目兼容入口，保留 `xMode` 的时间解释；本次普通 Line 不按时间轴自动改名。

`GraphSummaryStat = "none" | "mean" | "median" | "sum"`；`GraphErrorInterval = "auto" | "none" | "stdErr" | "stdDev" | "ci95"`；`GraphIntervalStyle = "errorBar" | "band"`。Points 另有 `jitter: "stacked" | "uniform" | "normal"`、`jitterLimit: number`；Line 另有 `rowOrder: boolean`、`connection: "line" | "step" | "spline"`、`fill: "none" | "toZero" | "between"`、`missingFactors: "skip" | "include"`、`missingValues: "connect" | "break"`。

## Task 1: 共用旧版设置定义和编辑器

**Files:** Create shared `graphLayerOptions.ts` / `GraphLayerOptions.tsx`; modify `GraphBuilderView.tsx`; test `tests/graphLayerOptions.test.ts` and `tests/graphLayerOptions.spec.tsx`.

**Interfaces:** Export `defaultPointOptions(): GraphPointOptions`, `defaultLineOptions(): GraphLineOptions`, `normalizePointOptions(value: unknown): GraphPointOptions`, `normalizeLineOptions(value: unknown): GraphLineOptions`。Export `PointsOptions` / `LineOptions`，输入 `options`、`onChange(patch)`、`t`、可选 `disabled`，保持旧版调用兼容。归一化只补合法缺省，旧 jitter=auto 映射 stacked，非法值拒绝。

- [ ] 写默认值、旧 jitter 别名、非法枚举/NaN/越界幅度测试；断言 point jitterLimit=0.5、line summaryStat=mean。CT 固定中英文设置顺序和 disabled。
- [ ] 运行 `node_modules/.bin/tsx --tsconfig tsconfig.app.json tests/graphLayerOptions.test.ts`，验证新契约缺失导致失败。
- [ ] 提取旧版 PointsOptions/LineOptions，实现接口；旧版原有表单控件行为与翻译不改变，新增可访问标签。
- [ ] 运行上述 TS 测试和 `node_modules/.bin/playwright test -c playwright-ct.config.ts tests/graphLayerOptions.spec.tsx`，要求全部通过。
- [ ] 检查旧版受影响图层 CT，通过后记录验证；如用户授权阶段性提交，提交本任务指定文件。

## Task 2: v3 文档、独立图层 store 与项目兼容

**Files:** Modify `src/types/graphBuilderNew.ts`, `src/stores/useGraphBuilderNewStore.ts`, `src/services/projectService.ts`, `src/types/project.ts`, `src-tauri/src/services/spprj_archive.rs`; create `graphNewLayers.ts`; tests `tests/graphNewLayers.test.ts`, `tests/workspaceGraphBuilderNew.test.ts`，Rust archive 内联测试。

**Interfaces:** `GraphBuilderNewDocumentV3` 保留图形级字段，`version: 3`、`layers: GraphNewLayer[]`，移除持久化全局 rawMode/showMean。`normalizeGraphNewDocument(item: PersistedGraphBuilderNewDocument): GraphBuilderNewDocumentV3`；store 新增 `addLayer(id, kind)`, `removeLayer(id, layerId)`, `setLayerOptions(id, layerId, patch)`。UI 迁移结束前提供只用于旧请求的 `legacyRenderOptions(layers)` 适配，不作为 v3 的权威状态。

- [ ] 写 v1/v2 六种 rawMode×showMean 的迁移测试；`pointsLine + true` 必须得到原始 Points、原始 Line、Mean Line 三层，且 Mean errorInterval=none。原始 Points jitterLimit=0；原始 Line 保留当前新版实际排序与断点规则。
- [ ] 写 v3 保存恢复、重复 ID/非法选项拒绝、打开不标脏、readonly拒绝修改、同值更新不标脏、删除最后层与新建默认值测试。
- [ ] 运行 `node_modules/.bin/tsx --tsconfig tsconfig.app.json tests/graphNewLayers.test.ts`，确认未实现契约失败。
- [ ] 实现确定性迁移图层 ID、深复制选项和新 store 操作；旧项目 time/duration 原始线保留兼容类型。新建、正常添加与迁移的附加 Line 分别遵循设计规则。
- [ ] 更新 Rust `validate_graph_builder_new_value` 支持 v1/v2/v3；写归档往返 fixture，确认 v3 不保存 transport、generation 或旧全局开关。
- [ ] 运行两个 TS 脚本和 `cargo test --manifest-path src-tauri/Cargo.toml graph_builder_new`，全部通过；记录并检查本任务 diff。

## Task 3: 完整源统计、误差区间及派生缓存

**Files:** Create `graph_new_layers.rs`, `graph_new_layers_cache.rs`; modify `services/mod.rs`, `graph_new_service.rs`, `graph_new_lod.rs`, `graph_new_cache.rs`，必要时 `graph_new_raw.rs`；Rust 模块内测试。

**Interfaces:** `LayerSourceRow { row_id: u64, x: Option<f64>, y: Option<f64>, group_code: u16 }` 保留原始缺失和源行身份；`LayerSummaryPoint { x: f64, y: f64, low: f64, high: f64, count: u64, group_code: u16 }`。`summarize_layer(rows, options, cancel) -> Result<Vec<LayerSummaryPoint>, AppError>` 接受完整分组来源。`GraphNewLayerPrepared` 由 Tasks 3/4 共同定义，包含分层原始/汇总几何和有效域。

- [ ] 写 `graph_new_layers_summary_*` 测试：同 X 的 Y=[1,2,3] 得 mean=2、median=2、sum=6、样本 stddev=1、SE=1/√3、CI95=1.96/√3；偶数组中位数、Overlay 隔离、单点和空组也固定。
- [ ] 写极大正负抵消、Sum 溢出、单点 n<2 零区间、LOD 未含异常点仍得到完整统计测试。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml graph_new_layers_summary`，确认失败。
- [ ] 实现稳定分组统计、完整数据计数和精确中位数；数据不可驻留时使用受磁盘预算控制的精确分组/排序；禁止从选中 LOD 推导。溢出返回明确配置诊断。
- [ ] 实现派生 cache key：来源身份、缺失/排序规则及图层统计配置；缓存预算预留发生在分配之前。取消不得发布半成品，压力不能破坏已有有效帧缓存。
- [ ] 运行该过滤测试与 `cargo test --manifest-path src-tauri/Cargo.toml graph_new_layers_cache`，验证压力、取消、精确外存中位数和来源 generation 隔离；全部通过后记录结果。

## Task 4: 原始点抖动、线连接、缺失处理和填充几何

**Files:** Extend `graph_new_layers.rs`; modify `graph_new_raw.rs`, `graph_new_overlay.rs`, `graph_new_renderer.rs`；参考 `src/graphCore/jitter.ts`；Rust 模块内测试。

**Interfaces:** `prepare_layer_geometry(source, layer, plot, domain, budget, cancel) -> Result<GraphNewLayerPrepared, AppError>`；图元类型为点、分组线段和三角填充，均携带 layer ID/group code。填充、误差带、主线、点按此顺序提交。

- [ ] 写 `graph_new_layers_geometry_*` 测试：源行与 X 顺序不同、重复 X 稳定顺序、Line/中点 Step/Spline、三种抖动与 0 幅度；相同 row ID 的随机模式重复准备结果一致。
- [ ] 写 X=[0,1,2], Y=[1,null,3]：Break=0 个跨缺失线段，Connect=1 个；Overlay 不串组；分类 X 缺失 Include 生成专门类别、Skip 排除，连续 X 缺失不映射零。
- [ ] 写 To Zero 覆盖零基线、Between 覆盖 low/high 且无有效区间时为空；Error Bar 和 Band 图元、单点曲线及超预算拒绝测试。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml graph_new_layers_geometry`，确认失败。
- [ ] 移植旧版确定性抖动算法并采用真实 plot 几何；保留缺失源行后再按设置分段；实现带分组边界的稳定路径、有限范围曲线细分与裁剪。生成区间和填充，不改变原始统计值。
- [ ] 原生 renderer 消费上述图元，保留现有 raw/mean 路径直至 Task 5 切换。运行 geometry 测试及 `cargo test --manifest-path src-tauri/Cargo.toml graph_new_layers_renderer`，要求小型像素 fixture 覆盖全部图元且预算受控。

## Task 5: 图层请求、原生服务及相机呈现集成

**Files:** Modify `src-tauri/src/models/graph_new.rs`, `graph_new_service.rs`, `graph_new_renderer.rs`, `src/services/graphNewService.ts`, `src/components/graphBuilderNew/GraphNewCanvas.tsx`, `tests/GraphBuilderNewHarness.tsx`, `tests/WorkspaceGraphNewHarness.tsx`, `tests/graphNewService.test.ts`；适配 `src-tauri/src/perf_harness.rs` 的请求/完成 fixture。

**Interfaces:** 请求增加 `layers: GraphNewLayer[]`；completion 增加 `layerStates: {layerId, available, reason, marks}[]` 和配置身份，保留已有 xAxis/yAxis、cameraDomain、plotRect 及准确计数契约。`graphNewService.render` 验证层 ID/配置身份与请求相符。Rust 同结构通过 serde 校验。

- [ ] 写前端契约测试拒绝未知选项、重复 ID、旧配置 completion；写 CT 快速设置 A→B、旧 decode 返回、切换来源、保存锁定等场景，断言旧帧不覆盖 B、不晚写文档。
- [ ] 写 Rust 首次域包含 Sum/区间、Reset 域来自当前图层、隐藏组隔离；同一相机多次渲染 sourceProjectionQueryCount=0。
- [ ] 运行 TS 服务测试、对应 CT 过滤和 Rust `graph_new_layers_service` 过滤，确认新增行为失败。
- [ ] 接通新请求和派生准备，旧配置在新的完整帧到达前可继续显示，状态明确表示配置处理中。先准备后发布域和图层状态；只读、取消和最新请求身份保护复用现有机制。
- [ ] 常规设置修改保持相机；初次自动范围和 Reset 使用当前 layers 的有效范围，jitter 不改变域。保持 WebView 可读轴文字和替换帧重试。
- [ ] 更新计数和性能 fixture，移除临时 `legacyRenderOptions` 适配；运行上述测试至全部通过并检查旧 transport 测试没有破坏。

## Task 6: Layers 卡片与旧版添加体验

**Files:** Create `src/components/graphBuilderNew/GraphBuilderNewLayers.tsx`; modify `GraphBuilderNewView.tsx`, `GraphBuilderNewView.css`, shared `GraphBuilderChrome.tsx`、中英文 locale；tests `graphBuilderNew.spec.tsx`, `GraphBuilderNewHarness.tsx`。

**Interfaces:** `GraphBuilderNewLayers({documentId, layers, disabled, layerStates})` 调用 Task 2 store；共用 Task 1 编辑器。GraphLayerCard 支持可选 icon 和 mode badge，既有其他调用默认行为保持兼容。

- [ ] 写 `layers parity` CT：默认只有 Scatter；添加 Line 得两卡且独立默认值；每一设置改动对应 store 与 render 请求；迁移两条 Line 各自设置不串联。
- [ ] 写删除最后层/重新添加、缺轴、+菜单不重复添加、Time Series 兼容不把普通 Line 改名、中英文与 390px 布局测试。只读和来源异常时控件禁用。
- [ ] 运行 `node_modules/.bin/playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx -g 'layers parity'`，確認现有界面失败。
- [ ] 实现独立卡片、图标、2D 标签、完整表单与 + 入口；移除共享 Mean 和设置占位按钮。诊断关联 layer ID，保留其他现有不可用功能。
- [ ] 添加 empty layers 提示翻译并保持缺轴提示优先；控制区可滚动，不把源码/缓存实现术语加入产品控件。
- [ ] 运行过滤 CT、旧版共用编辑器 CT 与 `tests/workspaceGraphNew.spec.tsx`，全部通过后检查局部 diff 和截图。

## Task 7: 性能、保存往返、审查与桌面验收

**Files:** Affected tests above; create `tests/graphNewLayersProjectRoundTrip.test.ts`；modify `docs/performance.md`，仅记录实测结果和有效约束。

- [ ] 写真实保存/恢复测试覆盖 migrated v1/v2、v3 全部设置、相机与隐藏组、空 layers 和迁移附加 Line，断言不丢图层且加载不误标脏。
- [ ] 写百万级数据配置切换/相机压力测试，断言完整统计结果、取消回收、预算上界和相机零重扫；只有必要源准备允许投影扫描。
- [ ] 跑新往返测试及 Rust 图层/归档过滤，先确认失败后补齐集成缺口；不得用测试 fixture 代替真实归档路径。
- [ ] 执行 `npm run build`，相关 TS 脚本，`node_modules/.bin/playwright test -c playwright-ct.config.ts tests/graphBuilderNew.spec.tsx tests/workspaceGraphNew.spec.tsx tests/graphLayerOptions.spec.tsx`，`cargo test --manifest-path src-tauri/Cargo.toml graph_new -- --test-threads=1` 和受影响归档测试；全部必须退出 0。
- [ ] `git --no-pager diff --no-ext-diff --check`；核对状态、精确变更范围和验证日志。发起独立整体验证审查，修复阻塞问题并重跑相关测试。
- [ ] 从工作树 261 启动桌面程序；人工验收点/线并存、不同设置、缺失连接、保存恢复、缩放和中文界面。验收后按用户授权提交/推送。

## 执行说明

Task 1→2→3→4→5→6→7 顺序执行。任务之间共享契约、迁移和渲染身份，实施中如需调整必须同步类型与后续任务，不能只补 UI。

建议 Native 执行：同一执行者连续维护前后端契约，完成后由独立审查者检查整体。也可选择逐任务子代理实施并审查，代价为每任务额外上下文与交接。待计划审阅和执行方式选择后开始产品代码变更。

命令中的 Node/Cargo 通过当前机器可用 PATH 运行；本机启动命令前确认运行时，不把本机绝对路径写入产品源码。设计文档与本计划尚未提交。
