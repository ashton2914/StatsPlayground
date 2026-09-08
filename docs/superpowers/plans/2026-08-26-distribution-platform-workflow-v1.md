# Distribution Platform Workflow V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在正式 StatsPlayground UI 中交付 Distribution 启动配置、Directory CRUD、项目持久化和可供统计 methods 接入的 revision/run 生命周期。

**Architecture:** React dialog 只编辑 versioned config，Zustand 管理当前项目项与瞬时 run state，Rust command/service 负责角色验证、snapshot 和事件四元组。此计划不实现统计公式；capability registry 为空时允许保存配置但 Run 保持禁用，连续描述计划注册 method 后启用真实运行。

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, Tauri v2, Rust 2021, DuckDB, Playwright CT 1.55.0.

**Spec:** [docs/superpowers/specs/2026-08-26-distribution-platform-workflow-v1.md](../specs/2026-08-26-distribution-platform-workflow-v1.md)

## Global Constraints

- 稳定 column ID 跨 IPC；前端不传 SQL、表名或表达式片段。
- 未注册 capability 不显示、不运行。
- 不保存统计结果、progress、cancel token 或 snapshot。
- stale/failed/cancelled run 不清空旧有效报告。
- 所有 UI 文案进入 `en/zh-CN/zh-TW/vi` i18n。
- 每个任务完成后更新批准范围台账对应 ID，但只有人工 UI 验收后才设 `uiAcceptance=passed`。

---

## File Map

- Create: `src/components/distribution/DistributionDialog.tsx`
- Create: `src/components/distribution/DistributionRoleZone.tsx`
- Create: `src/components/distribution/distributionConfig.ts`
- Modify: `src/components/distribution/DistributionWorkspace.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useDistributionStore.ts`
- Modify: `src/types/distribution.ts`
- Modify: `src/services/distributionService.ts`
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/commands/distribution_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/i18n/locales/{en,zh-CN,zh-TW,vi}.json`
- Create: `tests/distributionConfig.test.ts`
- Create: `tests/e2e/DistributionDialog.spec.tsx`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`

---

## Task 1: Versioned Analysis Configuration and Validation

**Files:**
- Modify: `src/types/distribution.ts`
- Modify: `src-tauri/src/models/distribution.rs`
- Create: `src/components/distribution/distributionConfig.ts`
- Create: `tests/distributionConfig.test.ts`

**Interfaces:**
- Produces `DistributionAnalysisConfigV1` exactly as the workflow spec.
- Produces `CapabilityOverrideEnvelopeV1` and descriptor-driven payload validation.
- Produces `validateDistributionConfig(config, columns): DistributionConfigErrorV1[]`.
- Produces `DistributionConfigErrorV1 { code, messageKey, fieldPath }`.

- [ ] **Step 1: Write failing TS/Rust contract tests**

```ts
assert.deepEqual(validateDistributionConfig(validConfig, columns), []);
assert.deepEqual(validateDistributionConfig({ ...validConfig, yColumns: [] }, columns)[0], {
  code: "distribution.config.yRequired",
  messageKey: "distribution.errors.yRequired",
  fieldPath: "yColumns",
});
assert.equal(validateDistributionConfig({ ...validConfig, confidenceLevel: 1 }, columns)[0].code,
  "distribution.config.confidenceOutOfRange");
```

Rust test serializes `confidenceLevel`, `histogramsOnly`, `enabledCapabilityIds`, and `capabilityOverrides` in camelCase.

- [ ] **Step 2: Run RED**

Run `npx tsx tests/distributionConfig.test.ts` and focused Rust model test. Expected: missing type/helper failures.

- [ ] **Step 3: Implement exact config and validation**

Validation rejects missing/duplicate/unknown role IDs, incompatible types, role conflicts, non-finite confidence and confidence outside `(0,1)`. It must not inspect display names.

Add tests rejecting unknown capability IDs, duplicate override envelopes, unknown payload versions and malformed method payloads. Contract authority is the mirrored Rust/TS V1 models named in the spec; both sides change in the same commit.

- [ ] **Step 4: Run GREEN and build**

Run focused tests and `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add src/types/distribution.ts src-tauri/src/models/distribution.rs src/components/distribution/distributionConfig.ts tests/distributionConfig.test.ts
git commit -m "feat(distribution): define analysis configuration"
```

## Task 2: Zustand CRUD, Naming, Copy, and Revision State

**Files:**
- Modify: `src/stores/useDistributionStore.ts`
- Modify: `tests/distributionArchive.test.ts`
- Create: `tests/distributionStore.test.ts`

**Interfaces:**
- Produces `createItem`, `copyItem`, `renameItem`, `commitConfig`, `beginRun`, `acceptResult`, `failRun`.
- `acceptResult` consumes `{analysisId, configRevision, runId, snapshotId}` and rejects non-current events.

- [ ] **Step 1: Write failing store tests**

Cover `Distribution 1/2` naming, copy with new ID/revision 1/no result, config revision increment, stale result ignored, failure preserving old result, delete clearing selection/run.

```ts
const accepted = store.acceptResult(staleEnvelope);
assert.equal(accepted, false);
assert.deepEqual(store.items[0].lastValidResult, previousResult);
```

- [ ] **Step 2: Run RED**

Run `npx tsx tests/distributionStore.test.ts`. Expected: missing actions.

- [ ] **Step 3: Implement minimal immutable store transitions**

Keep persisted `items` separate from transient `runStateByAnalysisId` and `resultByAnalysisId`; `loadFromProject` resets all transient maps.

- [ ] **Step 4: Run GREEN and archive regression**

Run store test plus `tests/distributionArchive.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/stores/useDistributionStore.ts tests/distributionStore.test.ts tests/distributionArchive.test.ts
git commit -m "feat(distribution): add analysis lifecycle store"
```

## Task 3: Role Dialog and Analyze Menu

**Files:**
- Create: `src/components/distribution/DistributionDialog.tsx`
- Create: `src/components/distribution/DistributionRoleZone.tsx`
- Modify: `src/components/distribution/index.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/i18n/locales/{en,zh-CN,zh-TW,vi}.json`
- Create: `tests/e2e/DistributionDialog.spec.tsx`

**Interfaces:**
- `DistributionDialog({dataset, columns, initialConfig, capabilities, onRun, onCancel})`.
- `onRun(config)` only fires after local validation.

- [x] **Step 1: Write failing component tests**

Mount with synthetic columns; verify search, Y multi-drop, Weight/Freq singleton, By multi-drop, Remove, Recall, confidence 95%, Cancel no callback, invalid Run blocked. Verify Analyze menu disabled without active dataset.

- [x] **Step 2: Run RED**

Run `npm run test:distribution:ui`. Expected: component/module missing.

- [x] **Step 3: Implement dialog using existing workspace visual patterns**

Use native inputs/selects, existing drag payload convention, no nested cards, stable dimensions. Do not clone competitor layout or text. Add all locale keys.

- [x] **Step 4: Run GREEN, localization JSON parse, build**

Run CT, parse all locale JSON files, run build.

- [ ] **Step 5: Commit**

```bash
git add src/components/distribution src/components/Workspace.tsx src/i18n/locales tests/e2e/DistributionDialog.spec.tsx
git commit -m "feat(distribution): add role configuration dialog"
```

## Task 4: Backend Run Coordination Boundary

**Files:**
- Modify: `src-tauri/src/models/distribution.rs`
- Modify: `src-tauri/src/services/distribution_service.rs`
- Modify: `src-tauri/src/commands/distribution_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/distributionService.ts`
- Create: `tests/distributionRunContract.test.ts`

**Interfaces:**
- Produces `DistributionRunAcceptedV1` and typed progress/completed/failed envelopes.
- Produces async `start_distribution_run` and `cancel_distribution_run` commands.
- Method execution is a registry dispatch; empty registry returns stable `distribution.run.noImplementedCapabilities` before acceptance.

- [x] **Step 1: Write failing command/service contract tests**

Assert command registration, camelCase envelope, opaque cancel, no-capability rejection, and four-key event identity. Assert command has `#[tauri::command(async)]`.

- [x] **Step 2: Run RED**

Run focused cargo test and TS service contract. Expected: commands absent.

- [x] **Step 3: Implement coordinator without statistics**

Validate config/roles, take snapshot, allocate run/cancel IDs, dispatch implemented method IDs, emit monotonic events. Do not add fake report blocks. Keep locks short and never run DuckDB work on Tauri main thread.

- [x] **Step 4: Run GREEN and full Rust suite**

Run focused tests then `cargo test`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models/distribution.rs src-tauri/src/services/distribution_service.rs src-tauri/src/commands/distribution_commands.rs src-tauri/src/lib.rs src/services/distributionService.ts tests/distributionRunContract.test.ts
git commit -m "feat(distribution): add run coordination boundary"
```

## Task 5: Directory CRUD and Workspace States

**Files:**
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/distribution/DistributionWorkspace.tsx`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `tests/e2e/DistributionWorkspace.spec.tsx`
- Create: `tests/e2e/DistributionDirectory.spec.tsx`

**Interfaces:**
- Directory context actions consume stable analysis ID.
- Workspace renders empty/ready/running/updating/cancelled/failed/missing/unknown/corrupt states.

- [x] **Step 1: Write failing CT tests**

Verify create selects item, rename, folder move, copy new ID, delete, Edit Inputs recall, missing source disabled run, unknown/corrupt read-only, stale completion ignored, old result visible while updating.

- [x] **Step 2: Run RED**

Run UI suite. Expected: missing menu/actions/state rendering.

- [x] **Step 3: Implement Directory actions and workspace state machine**

Reuse existing table/graph/tabulate menu patterns. Cancel active run on close/delete. No result view is fabricated while registry is empty.

- [x] **Step 4: Run GREEN, save/open regression, build**

Run CT, archive/store tests, build.

- [ ] **Step 5: Commit**

```bash
git add src/components/Workspace.tsx src/components/distribution/DistributionWorkspace.tsx src/stores/useFolderStore.ts tests/e2e
git commit -m "feat(distribution): wire directory analysis workflow"
```

## Task 6: Platform Acceptance and Ledger Update

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md`
- Create: `docs/superpowers/artifacts/2026-08-26-distribution-platform-acceptance.md`

- [x] **Step 1: Run automated gates**

Run `npm run test:distribution`, `npm run build`, and `cargo test`.

- [x] **Step 2: Record automatic results**

Set BASE-01..08 `developmentStatus=implemented`, `automationStatus=passing`, `uiAcceptance=pending`; record commit and commands in artifact.

- [ ] **Step 3: Product performs formal Tauri UI checklist**

Record each BASE ID as passed/failed with reproduction details. Do not mark passed from CT alone.

- [ ] **Step 4: Commit acceptance record**

```bash
git add docs/superpowers/specs/2026-08-26-analysis-distribution-approved-scope.md docs/superpowers/artifacts/2026-08-26-distribution-platform-acceptance.md
git commit -m "docs(distribution): record platform workflow acceptance"
```
