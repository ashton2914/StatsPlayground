# Distribution Platform Workflow V1 验收记录

**日期：** 2026-08-26
**范围：** BASE-01..BASE-08
**分支：** `user/xumax/analysis-distribution`
**工作树基线提交：** `b351594`
**实现提交：** 与完整 Distribution 交付一并提交
**自动验收：** 通过
**正式 Tauri UI 验收：** 待产品负责人执行

## 1. 验收边界

本记录只确认 Platform Workflow V1 的配置合同、角色对话框、Directory CRUD、项目持久化、run coordination boundary 和 lifecycle state machine。

当前 capability registry 为空，因此：

- 可以创建、保存、编辑和恢复 Distribution 配置；
- `Run` 在正式界面中按设计禁用；
- 不生成统计结果、报告块或图表数据；
- Continuous Descriptive Methods 与 Normal Process Capability 不属于本次验收；
- 真实长任务 progress/cancel、统计重算和报告原子替换必须在后续 method capability 注册后进行人工验收。

自动测试结果不得替代产品负责人在 StatsPlayground Tauri 界面中的正式操作结论。

## 2. 自动门禁结果

| 门禁 | 结果 | 关键输出 |
| --- | --- | --- |
| `npm run test:distribution` | passing | contracts、run contract、archive、isolation、snapshot、adapter、golden、black-box 全部通过；Playwright CT `11 passed` |
| `npm run build` | passing | `tsc -b` 与 Vite production build 通过；保留既有 chunk size warning |
| `cargo test --manifest-path src-tauri/Cargo.toml` | passing | `131 passed; 0 failed`；main/doc tests 无失败 |
| `git diff --check` | passing | 无 whitespace error；Windows 工作树仅报告 LF 将转换为 CRLF |
| locale JSON parse | passing | `en`、`zh-CN`、`zh-TW`、`vi` 全部可解析 |

## 3. BASE 自动验收映射

| ID | developmentStatus | automationStatus | uiAcceptance | 自动证据与当前限制 |
| --- | --- | --- | --- | --- |
| BASE-01 | implemented | passing | pending | Analyze 菜单、Dialog mount、无活动数据集禁用逻辑与 build 通过 |
| BASE-02 | implemented | passing | pending | Y multi-role、类型约束、未知列与角色冲突 validator 测试通过 |
| BASE-03 | implemented | passing | pending | Weight/Freq singleton、By multi-role、integer-compatible Frequency CT 通过 |
| BASE-04 | implemented | passing | pending | Search、Remove、Recall、95% confidence、Histograms Only、Cancel CT 通过 |
| BASE-05 | implemented | passing | pending | Store create/select/naming 与 Directory item 测试通过；空 registry 下 Run 禁用 |
| BASE-06 | implemented | passing | pending | stable-ID rename/move/copy/delete/Edit Inputs/Open Source、folder assignment 与 cancel boundary 测试通过 |
| BASE-07 | implemented | passing | pending | archive save/open、unknown/corrupt preservation、missing-source rebind 与 config revision 测试通过；无统计 method 可重算 |
| BASE-08 | implemented | passing | pending | accepted/progress/completed/failed 四键 identity、生产事件监听、forged/stale rejection、old result retention、状态矩阵 CT 通过；真实长任务待验收 |

## 4. 正式 Tauri UI 验收清单

产品负责人应在 StatsPlayground 正式界面中记录每项为 `passed` 或 `failed`。当前全部保持 `pending`。

### BASE-01

1. 打开包含至少一个数据表的项目。
2. 不选择数据表时确认 `Analyze > Distribution` 禁用。
3. 选择数据表后确认菜单启用并打开 Distribution 对话框。
4. 检查列列表、角色区和按钮在当前语言下显示正确。

**结果：** pending

### BASE-02 / BASE-03 / BASE-04

1. 搜索列并向 Y 分配多个连续列。
2. 向 Weight、Freq 各分配单列，确认再次分配会替换旧值。
3. 向 By 分配多个列。
4. 确认非整数兼容列不能作为 Freq。
5. 执行 Remove、Recall，修改 confidence level 与 Histograms Only。
6. 点击 Cancel，确认现有分析配置未变化。

**结果：** pending

### BASE-05

1. 保存有效配置，确认创建并选中 `Distribution N` Directory 项。
2. 确认当前 empty registry 状态下 `Run` 禁用且显示不可用提示。
3. 后续 method capability 注册后，重新验收 Save/Run revision 启动的原子语义。

**结果：** pending

### BASE-06

1. 在 Directory 中打开、重命名、拖动到文件夹、复制和删除分析。
2. 确认复制项具有新 analysis ID 并继承原文件夹。
3. 使用 Edit Inputs 修改配置并保存。
4. 删除或关闭 active run 时确认取消流程无残留状态。
5. 对 unknown/corrupt 项确认可移动、重命名、删除，但不可 Copy、Edit Inputs 或 Run。

**结果：** pending

### BASE-07

1. 保存项目、关闭并重新打开。
2. 确认 Distribution 名称、配置、revision 与 folder assignment 恢复。
3. 删除源表后确认显示 missing 状态且 Run 禁用。
4. 通过 Edit Inputs 选择替代数据表，保存后确认恢复 ready。
5. 后续 method capability 注册后，确认打开项目会按当前数据重算且不读取持久化统计结果。

**结果：** pending

### BASE-08

1. 后续 method capability 注册后启动真实长任务。
2. 确认 progress 单调、Cancel 可用、cancelled/stale/failed 状态准确。
3. 在旧报告存在时修改输入，确认 updating 期间旧报告继续可见。
4. 确认旧 run、错误 revision、错误 snapshot 的 completion 不替换当前报告。
5. 确认新 revision 完成后报告原子替换。

**结果：** pending

## 5. 失败记录模板

人工验收失败时填写：

- **受影响 ID：**
- **数据 fixture：**
- **复现步骤：**
- **预期结果：**
- **实际结果：**
- **日志或错误 code：**
- **修复提交：**
- **复验结果：**

## 6. 已知限制

- 当前 capability registry 为空，正式 UI 中 Run 禁用属于预期状态；首个统计 method capability 负责接入真实后台 dispatch 和事件发射。
- 尚无 Continuous Descriptive 或 Normal Process Capability 统计实现。
- 当前 build 仍有既有的 Vite chunk 大于 500 kB warning，不阻断本次平台验收。
- 全仓 `cargo fmt --check` 会报告本次任务之外的既有格式差异；本次 Rust 代码已通过编译和完整测试。
- 本次未执行 commit、merge 或 push。
