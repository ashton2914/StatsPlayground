# Distribution 正式报告自动验收记录

**日期：** 2026-08-27
**范围：** Continuous Descriptive V1、Overall-first 正式报告、Normal Process Capability V1
**自动验收：** passing
**产品 UI 验收：** pending

## Task 1 补充：JMP 19 Visual Compatibility Evidence Matrix

### Task 4 Fix Round 1（2026-08-28）

- 目标：仅处理审查缺测与本地缺陷候选，严格 TDD，不触碰 Task 5/6。
- 说明：仓库中未检索到独立命名为 `task-4-review` 的文档；本轮按 Task 4 要求清单逐项补测。

- 新增 Rust kernel tests（`src-tauri/src/services/distribution_kernel.rs`）：
	- `normal_quantile_compact_mixed_frequency_matches_expanded_points_when_bounded`
		- 覆盖 mixed-frequency compact 与 explicit expanded 在 `points.rank/probability/normalScore/observedValue` 的等价性。
	- `normal_quantile_rank_grid_above_two_thousand_keeps_first_center_and_last_rank`
		- 明确 `logicalN > 2000` 时 rank grid 包含 first、logical center、last。
	- `normal_quantile_n1_n2_and_constant_emit_finite_available_payloads`
		- 覆盖 `n=1`、`n=2`、constant 数据下点/线/band 有限值约束。

- 新增 Rust service integration tests（`src-tauri/src/services/distribution_service.rs`）：
	- `normal_quantile_service_integration_sets_provenance_and_typed_statuses`
		- unique points: `documentedCompatible`；
		- ties 与 freq-ties: `compatibilityPending`；
		- reference line 与 confidence band: `compatibilityPending`；
		- weight: `status=unavailable` 且 `reasonCode=normalQuantile.weightUnsupported.v1`。
	- `normal_quantile_service_payloads_avoid_nan_serialization_for_small_and_constant_groups`
		- `n=1/n=2/constant` 真实执行结果 JSON 序列化不含 `NaN`。
	- `histograms_only_result_has_no_normal_quantile_block`
		- `histogramsOnly=true` 时结果树中不生成 Normal Quantile block。

- 新增 UI CT（`tests/e2e/DistributionWorkspace.spec.tsx`）：
	- `normal quantile menu item depends on payload and chart stays hidden by default`
		- 无 block 时菜单无 `Normal Quantile Plot`；
		- 有 block 时菜单存在；默认不显示图；点击后显示。

- 本地缺陷修复（非 Task5/6 需求扩展）：
	- `npm run build` 暴露 `DistributionReport.tsx` 的类型错误：`aria-checked` 被 `histogramScale` 联合类型污染。
	- 通过收窄菜单 toggle key（仅布尔显示项）修复，保持行为不变，仅消除类型错误。

- TDD 结果记录：
	- 首轮 RED 验证中，新增用例在当前实现上全部先通过（行为已存在）。
	- 为避免“伪造 RED”，本轮通过补充可证伪边界（mixed-frequency compact/expanded 等价、`>2000` rank anchors、small/constant finite+no-NaN、service provenance/status 细粒度断言、UI 菜单显隐切换）来证明约束真实受保护。

### Fix Round 2（2026-08-27）

- Comparator 强化（`tests/distributionVisualCompatibility.test.ts`）：
	- `normalScore.documented.*` 明确按 compact `values` + optional `frequencies` 展开逻辑样本，并强制：
		- compact 与 logical fixture 有界（防止无界样本）；
		- `values` 与逻辑样本全量 finite；
		- `frequencies` 必须正整数（已有校验保留）；
		- documented case 必须无 ties；
		- 逻辑样本按 numeric ascending 排序得到 `observedValues`；
		- `expected.observedValues` 必须存在且精确等于排序后的逻辑样本；
		- `rank` 由排序索引 `1..N` 生成，`probability/score` 依此验证。
- 新增 mutation-style self-test：
	- 基线 case 使用非排序输入先通过；
	- 对 `expected.observedValues` 注入 wrong-order 与 wrong-value 两类突变，断言 comparator 必须失败。
- RED 证据（旧 fixture）：
	- 命令：`npx tsx tests/distributionVisualCompatibility.test.ts`
	- 结果：失败，报错 `TypeError: Cannot read properties of undefined (reading 'length')`，原因是 documented expected 缺失 `observedValues`。
- GREEN 证据（更新 fixture 后）：
	- fixture documented case 补充 `observedValues`；
	- 至少一个 documented case 输入改为非排序（`normalscore.documented.n3.unique`）；
	- freq documented case 的 compact `values` 改为非排序（`normalscore.documented.freq.n5.unique`）；
	- 命令：`npx tsx tests/distributionVisualCompatibility.test.ts`
	- 结果：`distribution visual compatibility contracts OK`。

- 新增 fixture：`tests/fixtures/distribution/jmp19-visual-diagnostics-v1.json`（machine-only，脱敏）。
- 新增 comparator test：`tests/distributionVisualCompatibility.test.ts`。
- Comparator 规则：
	- 结构字段精确匹配。
	- 浮点比较使用 `abs <= 1e-10` 或 `rel <= 1e-9`。
	- `normalScore.documented.*` 按排序后 `r_i` 计算 `p_i=r_i/(N+1)` 与 `z_i=Phi^-1(p_i)` 自动校验，可输出 `documentedCompatible`。
	- `histogram.jmpAuto.*`、`quantileBox.jmp19.*`、`stemLeaf.jmp19.*` 一律 machine-only `compatibilityPending`，不得判为 compatible。

当前缺失证据：

- 缺少 JMP 桌面黑盒输出，因此 `jmpAuto`、Quantile Box、Stem and Leaf 仅记录 `compatibilityPending`。
- 本仓仅保存 synthetic numeric/enum evidence，不保存截图、帮助正文、绝对路径、可见列名或自由文本。
- 本轮已建立 pending marker coverage（Histogram class+scale、Quantile Box class、Stem and Leaf class）；
	但 black-box matrix 的 numeric breadth（精确 bins/layers/stems 数值冻结）仍未完成，故不得对上述方法作 compatible 宣告。

## 自动证据

- `npm run test:distribution`：合同、adapter、golden、black-box 与 Playwright CT 全部通过；Playwright CT 为 `25 passed`。
- `npm run build`：TypeScript 与 Vite production build 通过，exit code `0`。
- `cargo test --lib`：`169 passed; 0 failed`。
- `cargo clippy --lib -- -D warnings`：已执行；被全仓 32 个既有 lint 阻塞，包括 `dead_code`、`too_many_arguments`、`needless_range_loop` 与 `type_complexity`。本轮未用 `allow` 掩盖，也未扩大范围重构无关模块。
- 四个 locale JSON 均可解析。
- Tauri smoke：`stats-playground` 桌面进程 `Responding=True`，Vite 页面返回 HTTP `200` 且包含应用 root。

## 已覆盖行为

- Overall 位于所有 By groups 之前，并复用同一次数据物化。
- By 标题保留字段语义，例如 `region = East`。
- Overview 使用横向 Histogram 与 Tukey Box 共享数值轴。
- Quantiles 与 Summary Statistics 使用紧凑语义表格。
- ECDF 默认隐藏，可从 Y 菜单启用。
- Y 与 Process Capability 显示偏好随分析配置保存，不增加统计 revision。
- 分析级 LSL/Target/USL override 可编辑、校验、清除并随项目保存，不回写 Table。
- Capability 输出 Process Summary、Within/Overall indices 与 CI、Nonconformance、PPM、规格线和 Normal density。

## 产品 UI 待验收场景

以下场景必须由产品负责人在正式 Tauri 窗口中操作后，才能将台账 `uiAcceptance` 改为 `passed`：

1. 多 Y、多 By 运行后 Overall 与各 By group 的顺序、折叠和滚动。
2. Overview、Quantiles、Summary、ECDF 菜单切换，保存项目并重开后恢复。
3. 无列属性规格时输入单侧和双侧 override，运行并检查 Capability 报告。
4. 清除 override 后恢复列属性规格来源，确认 Table 属性未改变。
5. 常数、短样本和均值位于规格外时的 typed state 与 warning。
6. `768x900`、`1024x700` 窗口下无横向溢出或控件遮挡。

自动测试与 smoke 不替代以上人工验收，因此当前 `uiAcceptance=pending`。