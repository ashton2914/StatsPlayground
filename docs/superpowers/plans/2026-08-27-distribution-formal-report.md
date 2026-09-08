# Distribution Formal Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付固定尺寸 Tauri 窗口可完整操作的 Distribution 配置工作区、Overall-first 正式报告树、组合 Overview 图表和自动 Normal Process Capability。

**Architecture:** 后端 Distribution executor/kernel 继续拥有全部统计计算并输出 versioned report tree/chart-data；React 只管理配置、折叠、滚动和展示；所有 chart-data 经 `distributionAdapter` 进入 graphCore。Normal Capability 从后端权威列 extras 或 analysis override 解析规格限，复用 continuous prepared observations。

**Tech Stack:** Rust 2021, DuckDB, statrs 0.18.0, Tauri v2, React 19, TypeScript, ECharts/graphCore, Playwright CT.

**Spec:** [docs/superpowers/specs/2026-08-27-distribution-formal-report-design.md](../specs/2026-08-27-distribution-formal-report-design.md)

## Global Constraints

- 不复制第三方产品布局、帮助正文或数值输出；截图只用于识别信息层级与操作需求。
- React 不计算统计量、不 re-bin、不重算 quartiles、indices 或 PPM。
- Histogram/Box/ECDF/capability chart-data 必须由后端预计算。
- 配置 By 时仍必须输出 Overall，且 Overall 位于所有 By groups 之前并复用同一次数据物化。
- Overview、Quantiles、Summary 默认显示；ECDF 默认隐藏，仅从 Y 分析菜单启用。
- 所有列引用使用持久化 column UUID，再解析为 trusted metadata name。
- `Histograms Only` 抑制所有非 Histogram blocks。
- 四语言键同步更新；正式 UI 验收保持 pending 直到产品操作完成。

---

## Task 1: 自适应配置工作区

**Files:**
- Modify: `src/components/distribution/DistributionDialog.tsx`
- Modify: `src/components/distribution/DistributionRoleZone.tsx`
- Modify: `src/components/distribution/distribution.css`
- Modify: `tests/e2e/DistributionDialog.spec.tsx`

**Interfaces:**
- Consumes: `DistributionColumnInfoV1 { columnId, name, modelingType, integerCompatible }`.
- Produces: viewport-safe dialog with sticky header/footer and scrollable body.

- [ ] **Step 1: Write failing CT**

At `768x900` and `1024x700`, assert role zones share one x coordinate below 900px, footer is visible, dialog has no horizontal overflow, and a long assigned name does not render one character per line.

- [ ] **Step 2: Run RED**

Run `npx playwright test -c playwright-ct.config.ts tests/e2e/DistributionDialog.spec.tsx`.

- [ ] **Step 3: Implement layout**

Split dialog into `.distribution-dialog-header`, `.distribution-dialog-scroll`, `.dialog-actions`; use `min-height:0`, sticky footer, single-column role grid below 900px, ellipsis for long names, and plain-language role hints.

- [ ] **Step 4: Run GREEN and build**

Run focused CT and `npm run build`.

## Task 2: Overall-first Versioned Report Tree Contract

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `tests/distributionRunContract.test.ts`
- Add/modify Rust service tests.

**Interfaces:**
- Produces `DistributionGroupResultV1 { groupKey, yResults }` and `DistributionYResultV1 { yColumn, quantiles, blocks }`.
- Report order is Overall -> By groups -> Y config order -> fixed block order.

- [ ] **Step 1: Write failing Rust/TS contract tests**

Assert Overall is always first, By group key preservation, Y UUID/name, 11 quantile probabilities, summary availability states, fixed block order, and Histograms Only suppression.

- [ ] **Step 2: Run RED**

Run focused cargo tests and `npx tsx tests/distributionRunContract.test.ts`.

- [ ] **Step 3: Implement typed tree**

Build the Overall accumulator and By report tree from the same prepared observations without issuing a second data query or flattening By/Y identity into block IDs. Preserve the existing four-key run envelope.

- [ ] **Step 4: Run GREEN**

Run contracts and full Rust build.

## Task 3: Formal Report UI and Scrolling

**Files:**
- Create: `src/components/distribution/DistributionReport.tsx`
- Create: `src/components/distribution/DistributionReportSection.tsx`
- Modify: `src/components/distribution/DistributionWorkspace.tsx`
- Modify: `src/components/distribution/distribution.css`
- Modify: locale JSON files
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

**Interfaces:**
- Consumes: Task 2 typed report tree.
- Produces: collapsible Overall/By/Y hierarchy, Y analysis menu, and complete compact Quantiles/Summary tables.

- [ ] **Step 1: Write failing CT**

Mount Overall + 3 By groups x 2 Y columns; assert Overall is first and expanded, By groups are collapsed, ECDF is hidden by default and can be enabled from the Y menu, keyboard toggle, compact Quantiles/Summary tables, unavailable reason, and ability to scroll the last block into view at `1024x700`.

- [ ] **Step 2: Run RED**

Run `npm run test:distribution:ui`.

- [ ] **Step 3: Implement hierarchy**

Use semantic disclosure buttons, sticky Workspace controls, a `min-height:0; overflow:auto` report body, Y analysis display menus, and compact non-card tables grouped by Location/Variation.

- [ ] **Step 4: Run GREEN/build/locales**

Run CT, parse four locale JSON files, and build.

## Task 4: Combined Overview and Optional ECDF Rendering

**Files:**
- Modify: `src/graphCore/distributionAdapter.ts`
- Modify: `src/graphCore/types.ts` if required
- Create: `src/components/distribution/DistributionChart.tsx`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Modify: `tests/distributionGraphAdapter.test.ts`
- Create: `tests/e2e/DistributionCharts.spec.tsx`

**Interfaces:**
- Consumes backend `histogramData`, `boxPlotData`, `cdfData`.
- Produces a shared-value-axis horizontal Histogram + Tukey Box Overview and optional ECDF graphCore specs only; no statistical transformations.

- [ ] **Step 1: Write adapter RED**

Assert bins, whiskers/outliers and ECDF coordinates survive byte-for-byte; count-axis maximum derives from bin counts; and no helper computes statistics.

- [ ] **Step 2: Write canvas CT RED**

Mount the combined Overview and optional ECDF at desktop/narrow widths and assert nonblank canvas pixels, shared vertical value range, stable dimensions, accessible label, and no overlap.

- [ ] **Step 3: Implement chart adapter/rendering**

Translate chart-data into existing graphCore field/encoding inputs. The horizontal histogram and Tukey Box share the value axis; count range uses `max(bin.count)`. Follow custom-series `clip:true`, no custom `encode` when using `api.coord`, and no frontend re-binning.

- [ ] **Step 4: Verify**

Run adapter tests, CT screenshots/pixel checks, and build.

## Task 5: Complete Continuous Tables

**Files:**
- Modify: `src-tauri/src/services/distribution_kernel.rs`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src/types/distribution.ts`
- Modify: `src/components/distribution/DistributionReport.tsx`
- Add Rust property/golden tests and CT.

**Interfaces:**
- Produces all 11 approved Type-6 quantiles, Mean CI, typed unavailable reasons, W/nEff provenance.

- [ ] **Step 1: Add missing RED matrix**

Cover exact knot/epsilon cases, `1<nEff<2`, Weight x Freq expansion, modes with noninteger mass ties, empty and D<=0 typed unavailable, and proptest scale/frequency invariants.

- [ ] **Step 2: Run RED**

Run distribution kernel tests.

- [ ] **Step 3: Complete contracts and UI**

Serialize complete quantile/summary values and display all approved fields with reason labels.

- [ ] **Step 4: Run GREEN/golden**

Run kernel, service, TS and UI tests.

## Task 6: Specification Source and Normal Capability Kernel

**Files:**
- Create: `src-tauri/src/services/normal_capability.rs`
- Modify: backend models/service/executor
- Modify: table archive/extras access as needed
- Create Rust tests and golden fixture.

**Interfaces:**
- Produces `SpecificationLimitsV1`, `NormalProcessSummaryV1`, typed indices, intervals, nonconformance and capability chart-data.

- [ ] **Step 1: Implement Normal Capability plan Tasks 1-4 using RED/GREEN**

Follow [2026-08-26-distribution-normal-capability-v1.md](2026-08-26-distribution-normal-capability-v1.md) exactly for source resolution, MR sigma, indices, CI and PPM.

- [ ] **Step 2: Integrate automatic trigger**

Resolve `extras.spec` by Y column UUID at snapshot time. No valid LSL/USL means block absent; Weight/Freq means unavailable.

- [ ] **Step 3: Verify golden matrix**

Cover no/target-only/one-sided/double-sided/invalid/constant/n<2/By/filter cases.

## Task 7: Capability Editor and Report UI

**Files:**
- Create: `src/components/distribution/SpecificationLimitsEditor.tsx`
- Create: `src/components/distribution/ProcessCapabilityReport.tsx`
- Modify: Dialog/Report/adapter/locales/tests.

- [ ] **Step 1: Write CT RED**

Cover column property source, override badge/remove, invalid input, no-spec hidden, one-sided report and Weight/Freq unavailable.

- [ ] **Step 2: Implement editor and report**

Use a Process Capability subtree and display menu for Capability Histogram, Process Summary, Within Sigma Capability, Overall Sigma Capability and Nonconformance. Render compact tables, CI columns, and chart series from backend data.

- [ ] **Step 3: Verify no writeback**

Assert overrides persist in Distribution config and no Table property command is invoked.

## Task 8: Acceptance and Ledger

**Files:**
- Modify approved-scope ledger
- Create/update descriptive and capability acceptance artifacts.

- [ ] **Step 1: Run automated gates**

Run `npm run test:distribution`, `npm run build`, full `cargo test`, `cargo clippy -- -D warnings`, locale parse, and Tauri smoke.

- [ ] **Step 2: Update statuses**

Only covered DESC/CAP IDs become `implemented/passing/pending`.

- [ ] **Step 3: Product UI acceptance**

Record actual Tauri operations; do not infer passed from CT.
