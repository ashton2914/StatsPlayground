# Distribution Platform Workflow V1 Specification

**版本：** 1.0.0
**状态：** 产品规格已批准，待实施
**覆盖 ID：** BASE-01 至 BASE-08
**范围权威：** [批准范围与验收台账](2026-08-26-analysis-distribution-approved-scope.md)
**基础合同：** Phase 0 Rust `src-tauri/src/models/distribution.rs` 与 TypeScript `src/types/distribution.ts` 的 V1 mirrors；字段变更必须同步更新两端 contract tests 与 schema version

## 1. 目标

交付可在 StatsPlayground 正式界面中操作的 Distribution 平台纵向流程：启动、角色配置、运行、Directory 项目管理、进度/取消、旧结果保留、项目保存/打开和重算。本规格不定义统计公式；统计 block 只来自已注册的 method capability。

## 2. 入口与可用条件

- 菜单路径为 `Analyze > Distribution`。
- 仅当存在活动数据集、项目可修改且 bootstrap 成功时启用。
- 无活动数据集、项目只读、bootstrap 失败时菜单禁用，并提供 i18n 原因 key。
- capability registry 是功能可见性的唯一来源。未注册 method 不显示菜单、选项或空占位。

## 3. 启动对话框

### 3.1 布局与角色

- 左侧为活动数据集列列表，支持搜索、类型图标、多选和拖放。
- 角色区包含：一个或多个 `Y`，可选单个 `Weight`、单个 `Freq`、一个或多个 `By`。
- 同一稳定 column ID 不可重复出现在互斥角色中。
- `Y` 只接受连续数值列；首版暂不显示 Nominal、Ordinal、Multiple Response 分析入口。
- `Weight` 接受数值列；`Freq` 接受整数兼容数值列；`By` 接受连续、分类和日期列。
- 控件包括列搜索、Remove、Recall、Histograms Only、置信水平、Run、Cancel。
- 置信水平默认为 `0.95`，分析级合法范围为 `0 < confidenceLevel < 1`，UI 预设 0.90/0.95/0.99 并允许合法自定义值。

### 3.2 Recall 与 Cancel

- Recall 恢复该分析最近一次已提交配置；新建分析时恢复本次会话最近一次成功运行的启动配置，但重新绑定当前 dataset ID。
- Cancel 关闭对话框，不创建项目项、不修改当前配置、不启动 revision。
- Edit Inputs 使用当前分析已提交配置初始化；未提交的编辑不持久化。

### 3.3 Run 前验证

Run 必须在前端做即时提示，并由后端重复验证：

- 至少一个 Y；所有稳定 column ID 存在且类型兼容。
- Weight/Freq/By 不与 Y 冲突。
- `confidenceLevel` 有限且位于开区间 `(0,1)`。
- FilterExpr schema 可识别。
- resource budget 合法。
- 若验证失败，不创建 revision；返回稳定 error code 和字段路径。

稳定字段路径至少覆盖 `yColumns`、`weightColumnId`、`frequencyColumnId`、`byColumnIds`、`filterExpr`、`confidenceLevel`、`resourceBudget`、`enabledCapabilityIds` 和 `capabilityOverrides[index].payload`。

## 4. 分析项与配置合同

```ts
interface DistributionAnalysisConfigV1 {
  schemaVersion: "1";
  sourceDatasetId: string;
  yColumns: DistributionColumnRefV1[];
  weightColumnId: string | null;
  frequencyColumnId: string | null;
  byColumnIds: string[];
  filterExpr: FilterExprV1;
  confidenceLevel: number;
  histogramsOnly: boolean;
  enabledCapabilityIds: string[];
  capabilityOverrides: CapabilityOverrideEnvelopeV1[];
}

interface CapabilityOverrideEnvelopeV1 {
  schemaVersion: "1";
  capabilityId: string;
  payloadSchemaVersion: string;
  payload: Record<string, unknown>;
}
```

每个 capability descriptor 必须注册唯一 `capabilityId + payloadSchemaVersion` validator。保存和 Run 均拒绝未注册 capability、未知 payload version、重复 capabilityId 或不符合 method payload contract 的字段；不得静默保存无模式 payload。Normal Capability V1 的 payload 由其 method spec 冻结。

`DistributionDocV1.currentConfig` 必须收敛为上述结构，不保存统计结果、chart points、progress、cancel token 或 snapshot。

新建成功后使用稳定 analysis ID 创建 `Distribution N`，加入 Directory 根目录并选中。计数器从现有名称最大后缀继续，不因删除复用编号。

## 5. 运行合同

### 5.1 IPC

新增命令：

```rust
start_distribution_run(
    state: State<'_, AppState>,
    app: AppHandle,
    request: DistributionRequestV1,
) -> Result<DistributionRunAcceptedV1, AppError>

cancel_distribution_run(
    state: State<'_, AppState>,
    token: DistributionCancelTokenV1,
) -> Result<(), AppError>
```

```ts
interface DistributionRunAcceptedV1 {
  analysisId: string;
  configRevision: number;
  runId: string;
  snapshotId: string;
  cancelToken: string;
}
```

后端事件：

- `distribution-progress`：`DistributionProgressV1`。
- `distribution-completed`：完整 `DistributionResultV1`。
- `distribution-failed`：结构化 `DistributionRunFailureV1`。

事件必须携带 `analysisId/configRevision/runId/snapshotId`，store 只接受与当前 run 四元组匹配的事件。

### 5.2 Revision 与旧结果

- 新建分析从 `configRevision = 1` 开始；每次成功提交 Edit Inputs 增加 1。
- 启动新 revision 时，旧有效报告继续显示并标记 updating。
- 新结果仅在 snapshot current、analysis/current revision/run 四元组匹配时原子替换。
- stale、cancelled、failed 结果不得清空旧有效报告。
- 同一分析启动新 run 时，旧 run 尽早取消；无法取消的完成事件由 store 丢弃。

### 5.3 Progress 与 Cancel

- progress `current`、`percent` 在同一 run 内不得下降。
- Cancel 按钮只在 running 时启用；token 仅做 opaque 等值匹配。
- Cancel 后状态为 cancelled；后端停止后不提交结果。
- 关闭项目时取消全部活动 Distribution runs 并解除事件监听。

## 6. By 分组与稳定顺序

- 多个 By 按角色顺序形成复合 key。
- 数值升序；日期按 UTC instant 升序；分类优先使用声明 value order，其余按稳定 Unicode code-point 顺序。
- 缺失 By 形成独立 Missing 分组，并排在每一维非缺失值之后。
- 排序规则由后端执行并返回 typed group keys；前端不得重新排序。

## 7. Directory 生命周期

每个 Distribution 项支持：打开、重命名、移动、复制、删除、打开源表、Edit Inputs。

- 复制生成新 analysis ID、名称和 revision 1，复制已提交配置，不复制结果/run/snapshot。
- 删除分析同时删除其 derived formulas 前必须提示依赖；首版无公式时直接删除。
- 源表删除后保留项目项并显示 `missingSource`；可通过 Edit Inputs 重绑定。
- 未知版本和 corrupt 项只读，可移动、重命名或删除，不可 Run/Edit Inputs。

## 8. 项目持久化与重算

- 保存分析配置、名称、folder、显示/折叠状态和 capability overrides。
- 不保存报告结果。打开项目后先恢复 Directory，再对可运行分析按用户触发或明确的恢复策略重算；不得在项目打开关键路径中阻塞所有表加载。
- 手工规格覆盖等 method 参数属于 `capabilityOverrides`，由对应 method spec 定义。

## 9. UI 状态

必须显示：empty、ready、running、updating、cancelled、failed、stale、missingSource、unknownVersion、corrupt。

错误显示使用 `messageKey + fieldPath + code`，不得依赖后端自由文本匹配。报告 block 的 unavailable 不升级为全局失败；非法角色、missing source、snapshot stale、预算超限为全局 run failure。

## 10. 自动与人工验收

自动测试覆盖：菜单启用条件、角色 DnD、验证、Cancel 不修改、Run 创建项、revision 原子替换、旧事件丢弃、progress 单调、CRUD、save/open、missing source、unknown/corrupt。

人工验收按批准范围台账第 6.2 节执行。BASE-01..08 只有在正式 Tauri UI 完成对应操作后，`uiAcceptance` 才能设为 `passed`。

## 11. 明确不做

- 不实现暂缓统计 method。
- 不在 React 计算统计量。
- 不持久化运行结果。
- 不提供脚本、SQL 或 JSL 输入。
- 不复制任何第三方界面、文案或视觉素材。
