# Issues #83/#91 Fit Model 核心闭环验收证据

**日期：** 2026-09-02

**分支：** `user/xumax/regression-analysis-op`

**结论：** 自动化 Fit Model 专项门槛通过；仓库级 Rust gate 与 Tauri 人工验收尚未全部通过，因此暂不将设计状态更新为“已实现并验收”，也不建议关闭 #83/#91。

## 1. Gate 汇总

| Gate | 命令 | 结果 | 状态 |
|---|---|---|---|
| Fit Model TypeScript 合同 | `npm run test:fit-model` | 16 个显式合同脚本全部通过；locale parity 为 4 种语言、186 个叶子键 | 通过 |
| Fit Model Playwright CT | `npm run test:fit-model:ui` | 10/10 通过，含 1280x800 与 390x844 viewport | 通过 |
| 前端生产构建 | `npm run build` | `tsc -b` 与 Vite build 成功；仅有既有 dynamic-import/chunk-size warning | 通过 |
| Rust Fit Model OLS | `cargo test engine::fit_model::ols::tests -- --nocapture` | 16/16 通过 | 通过 |
| Rust 全量测试 | `cargo test` | 497 通过、2 失败 | 阻塞 |
| Rust strict clippy | `cargo clippy -- -D warnings` | 70 个仓库级既有 lint error | 阻塞 |
| Tauri dev smoke | `npx tauri dev --config '{"build":{"beforeDevCommand":"npm run dev -- --port 1421","devUrl":"http://localhost:1421"}}'` | Vite 1421 启动；Cargo 无法替换被占用的 `target/debug/stats-playground.exe`，桌面进程未启动 | 阻塞 |
| Tauri 人工交互 | 三类 construct、诊断、Profiler、Save/Undo/Redo、项目重开 | 当前会话未执行人工点击验收 | 待执行 |

### Tauri smoke 阻塞

- **关键输出：** `failed to remove file ... target\debug\stats-playground.exe`，`Access is denied. (os error 5)`。
- **重试结论：** 改用 1421 端口后已排除 Vite 端口冲突，失败点仍是 Windows 对既有桌面二进制的文件锁；不能据此声称 Tauri 应用已启动。
- **后续动作：** 关闭占用该二进制的既有进程后重新运行 smoke，再执行第 7 节人工交互验收。

### Rust 全量测试阻塞

1. `services::graph_data_service::tests::aggregate::raw_chunks_project_multi_x_columns_as_categorical_axis_values`
   - 稳定复现：`InvalidParam("graph request is missing role y")`。
   - 与 Fit Model 修改无关，单测独立重跑仍失败。
2. `services::streaming_project_writer::tests::stream_writer_progress_first_advancing_event_waits_for_minimum_interval`
   - 时间阈值断言失败：`first_delta_ms <= 520`。
   - 属于 project streaming writer 的计时测试，不属于 Fit Model 范围。

### Strict clippy 阻塞

`cargo clippy -- -D warnings` 报告 70 个既有错误，分布于 table commands、DuckDB engine、Distribution、Graph Data、project save/archive 等模块；包含 dead code、`too_many_arguments`、`needless_range_loop`、`derivable_impls`、`large_enum_variant` 等。Fit Model 范围内另有 `terms.rs` 的 `unnecessary_lazy_evaluations`。根据执行计划，不把仓库级 lint 清理混入 Fit Model 验收提交。

## 2. 256 项构造上限

- **命令：** `npm run test:fit-model`，其中执行 `tests/fitModelConstruct.test.ts`。
- **输入 fixture：** 9 个 continuous predictors，调用 `buildFullFactorialTerms`；全因子项数为 $2^9-1=511$。
- **关键输出摘要：** `MAX_FIT_MODEL_TERMS === 256`；构造函数在生成 511 项前抛出包含 `256` 的错误；3 predictors 的 full factorial 正确生成 7 项。
- **通过阈值：** 不允许返回超过 256 项的 definition；合法输入保持 canonical 顺序。
- **失败与重试结论：** 本次一次通过；超限在前端构造阶段确定性拒绝，不进入 Rust fit。

## 3. 8,000 行 diagnostics/Q-Q 上限

- **命令：** `cargo test samples_row_and_qq_diagnostics_to_render_budget -- --nocapture`。
- **输入 fixture：** `GRAPH_SCATTER_RENDER_BUDGET + 1` 行有效诊断数据。
- **关键输出摘要：** `diagnostics.rows.len()` 与 `qq_rows.len()` 均被限制为 `GRAPH_SCATTER_RENDER_BUDGET`，并设置 `rows_sampled=true`、`qq_rows_sampled=true`；测试 1/1 通过。
- **通过阈值：** report row diagnostics 和 Q-Q payload 各不超过 8,000 点，source row count 保留全量计数。
- **失败与重试结论：** 本次一次通过；无需重试。Save Columns 使用内部全量 diagnostics，不使用采样 payload。

## 4. 101 点 Profiler 上限

- **命令：** `npm run test:fit-model`，其中执行 `tests/fitModelPrediction.test.ts` 与 `tests/fitModelProfiler.test.ts`。
- **输入 fixture：** predictor `A` 范围 `[0,4]`，请求 101 点和超限 1,000 点扫描。
- **关键输出摘要：** 101 点请求返回 101；1,000 点请求仍返回 101；首尾为 0 和 4，所有 predicted 值有限。
- **通过阈值：** 每个 profiler scan 最多 101 点，端点完整且预测值有限。
- **失败与重试结论：** 本次一次通过；无超限 payload。

## 5. Save Columns generation 只增加一次

- **命令：** `cargo test save_columns_writes_complete_cases_and_leaves_excluded_rows_null -- --nocapture`；`cargo test valued_columns_ -- --nocapture`。
- **输入 fixture：** 3 行 complete cases 加 1 行 predictor 为 NULL 的 excluded row；保存 `Predicted` 与 `Residual`。
- **关键输出摘要：** service 返回 `generation=1`，数据库 generation 同为 1；前三行两列均有值，excluded row 两列均为 NULL；Undo 删除整组，Redo 恢复列和值。
- **通过阈值：** 单次保存仅增加一次 generation，并记录一个可执行 change set；excluded rows 不填值。
- **失败与重试结论：** service 测试 1/1、valued columns 测试 4/4 通过；无需重试。

## 6. 失败事务零残留

- **命令：** `cargo test valued_columns_ -- --nocapture`。
- **输入 fixture：** 第二个保存列引用不存在的 row ID 99；另有 stale expected generation fixture。
- **关键输出摘要：** 中途失败后 user columns 仍只有原始 `existing` 列，generation 保持 0；stale generation 同样零 mutation；整组重名使用统一 `-2` suffix。
- **通过阈值：** 任一写入、generation 或 commit 失败均不留下列、值、metadata、history 或 generation 部分变更。
- **失败与重试结论：** 4/4 通过；失败路径不需要补偿重试，调用方可在重新获取 generation 后发起全新请求。

## 7. 人工验收待办

以下步骤必须在桌面窗口中逐项执行并补充截图/观察结果，完成前不得关闭 #83/#91：

- 创建 `Full Factorial`、`Factorial to Degree`、`Response Surface` 三种模型。
- 核对响应面方程以及 LOF、VIF、row diagnostics、Q-Q。
- 操作 Profiler slider/number input，验证同步、区间与 extrapolation warning。
- 保存默认 5 列与全部 9 列，验证源表刷新、Undo、Redo。
- 保存项目、关闭、重开，验证旧/新 Fit Model definition 恢复并重新计算。

## 8. 非目标后续 Issues

- [#114](https://github.com/ashton2914/StatsPlayground/issues/114)：categorical predictor coding。
- [#115](https://github.com/ashton2914/StatsPlayground/issues/115)：stepwise/model selection。
- [#116](https://github.com/ashton2914/StatsPlayground/issues/116)：logistic regression/GLM。
- [#117](https://github.com/ashton2914/StatsPlayground/issues/117)：inverse prediction。
- [#118](https://github.com/ashton2914/StatsPlayground/issues/118)：desirability/response optimization。
- [#119](https://github.com/ashton2914/StatsPlayground/issues/119)：扩展 residual diagnostics/tests。

## 9. 关闭判定

当前不满足关闭条件。需要先：

1. 修复或隔离 2 个仓库级 Rust test failures，使 `cargo test` 为 0 failures。
2. 建立仓库 clippy baseline 或清理 70 个 lint errors，使计划要求的 strict clippy gate 可执行。
3. 完成第 7 节 Tauri 人工交互验收并补录证据。
4. 全部 gate 通过后，将设计状态从“已批准”更新为“已实现并验收”，再关闭 #83/#91。
