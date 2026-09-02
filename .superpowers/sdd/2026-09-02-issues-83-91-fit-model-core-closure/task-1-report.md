# Task 1 Report - TypeScript Construct 与持久化协议

## 实现内容
- 新增 `src/components/fitModel/fitModelConstruct.ts`：
  - `MAX_FIT_MODEL_TERMS = 256`
  - `countFactorialTerms(factorCount, degree)`
  - `buildFullFactorialTerms(fields)`
  - `buildFactorialToDegreeTerms(fields, degree)`
  - `buildResponseSurfaceTerms(fields)`
  - 组合数预判 + 上限保护，超过 256 在分配 term 前抛错（9 predictors full factorial 在 511 前拒绝）。
- 更新 `src/types/fitModel.ts`：
  - 增加 `FitModelConstruct`（manual/fullFactorial/factorialToDegree/responseSurface）。
  - 扩展 `FitModelTerm` 支持 `power`（runtime 严格校验 exponent=2）。
  - `FitModelItem` 增加 `construct` 字段。
- 更新 `src/components/fitModel/fitModelConfig.ts`：
  - interaction canonicalize 支持任意 arity，按字段名字典序。
  - identity key 改为 length-prefix 编码；不使用 `join("*")` 作为身份。
  - `power` term 校验：arity=1，exponent=2，且强层级要求存在对应 main。
  - interaction 校验：arity>=2、列名不得重复、强层级要求所有主效应存在。
  - `createFitModelItem` 默认补 `construct: { kind: "manual" }`，保持旧调用兼容。
- 更新 `src/stores/useFitModelStore.ts`：
  - 归档 normalization 支持 construct 解析；缺失 construct 迁移 manual。
  - `parseTerm` 显式校验 main/interaction/power，非法 power exponent 进入 `invalidTerm:<index>`。
  - 保持 `invalidPersistedDefinition` 隔离策略。
- 更新 `src/components/fitModel/index.ts` 导出新 construct API。

## RED 证据（先测后改）
执行：
- `npx tsx --tsconfig tsconfig.app.json tests/fitModelConstruct.test.ts`
- `npx tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts`

真实输出要点：
- `ERR_MODULE_NOT_FOUND`: `src/components/fitModel/fitModelConstruct.ts` 不存在。
- `AssertionError`: `canonicalizeFitModelTerms` 未对三因子 interaction 做排序（期望 `[A,B,C]`，实际 `[C,A,B]`）。

## GREEN 证据
执行：
- `npx tsx --tsconfig tsconfig.app.json tests/fitModelConstruct.test.ts`
- `npx tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts`
- `npx tsx --tsconfig tsconfig.app.json tests/fitModelStore.test.ts`
- `npx tsx --tsconfig tsconfig.app.json tests/fitModelArchive.test.ts`
- `npx tsc -b --pretty false`

真实输出：
- `fitModelConstruct contract tests passed`
- `fitModelConfig contract tests passed`
- `fitModel store contract passed`
- `fit model archive contracts OK`
- `tsc -b` 无错误输出，exit 0。

## 测试文件变更
- `tests/fitModelConstruct.test.ts`（新增）
- `tests/fitModelConfig.test.ts`
- `tests/fitModelStore.test.ts`
- `tests/fitModelArchive.test.ts`

## 兼容性说明
- 保持旧 main/two-way JSON 可读。
- 缺失 `construct` 的旧归档项自动迁移为 `{ kind: "manual" }`。
- 非法新 term（如 `power` exponent 非 2）不会导致整项丢失，而是通过 `loadIssue.code = "invalidPersistedDefinition"` 与 `detail = "invalidTerm:<index>"` 隔离。
- 旧归档 fixture（无 construct、main/two-way interaction、`centeringMethod="mean"`）加载后，生成 fit request 语义（response/terms/centering）保持基线。

## 自审
- 仅修改 brief 指定的 9 个文件 + 报告文件。
- 未扩展 UI、未改 Rust、未引入 Rust 拟合数值模拟。
- 所有逻辑改动遵循最小实现原则，聚焦 TS construct 与持久化协议。

## Concerns
- 当前 `FitModelTerm` 类型为兼容既有克隆路径，保留了一个宽松兼容分支；严格语义由 `validateFitModelDefinition` 与 `parseTerm` 在 runtime 保证。
- 若后续任务允许改动更多调用点，可进一步收紧到纯严格 discriminated union 并清理兼容分支。

## Fix Round 1

### 改动
- 收紧 `src/types/fitModel.ts` 的公开 `FitModelTerm` 为纯严格 discriminated union：
  - `main`: `{ kind: "main"; columnNames: [string] }`
  - `interaction`: `{ kind: "interaction"; columnNames: [string, string, ...string[]] }`
  - `power`: `{ kind: "power"; columnNames: [string]; exponent: 2 }`
- 在 `tests/fitModelConfig.test.ts` 增加 compile-time contract（`satisfies` + `@ts-expect-error`）：
  - 非法 main arity、非法 interaction arity、power 缺 exponent 均被类型系统覆盖。
- 保留宽松旧 payload 仅在 `src/stores/useFitModelStore.ts` 的 `parseTerm(unknown)` 边界中解析，parse 后返回严格 `FitModelTerm`。
- 最小连带修复：
  - `src/components/fitModel/fitModelConstruct.ts`：interaction 生成处补 tuple 类型。
  - `src/components/fitModel/fitModelConfig.ts`：canonicalize/identity 路径统一返回 strict interaction tuple；power canonicalize 固定 `exponent: 2`。
  - `src/components/fitModel/fitModelReportModel.ts`：clone term 时区分 main/interaction/power，避免丢失 power exponent（严格类型收紧后的必要编译修复）。

### 覆盖测试文件
- `tests/fitModelConfig.test.ts`
- `tests/fitModelConstruct.test.ts`
- `tests/fitModelStore.test.ts`
- `tests/fitModelArchive.test.ts`

### RED/GREEN 命令与真实输出
- RED（类型收紧后首次构建暴露连带编译问题）：
  - `npx tsc -b --pretty false`
  - 输出：`src/components/fitModel/fitModelReportModel.ts(76,3): error TS2322 ... Property 'exponent' is missing ...`
- GREEN：
  - `npx tsx --tsconfig tsconfig.app.json tests/fitModelConstruct.test.ts`
  - `npx tsx --tsconfig tsconfig.app.json tests/fitModelConfig.test.ts`
  - `npx tsx --tsconfig tsconfig.app.json tests/fitModelStore.test.ts`
  - `npx tsx --tsconfig tsconfig.app.json tests/fitModelArchive.test.ts`
  - `npx tsc -b --pretty false`
  - 输出：
    - `fitModelConstruct contract tests passed`
    - `fitModelConfig contract tests passed`
    - `fitModel store contract passed`
    - `fit model archive contracts OK`
    - `EXIT_CODE=0`

### 自审
- 本轮未引入新的 public escape hatch；严格公开类型与 loader unknown parser 边界分离清晰。
- `power` term 的 `exponent` 在公开类型与克隆/canonicalize 路径均为必填字面量 `2`。
- 未扩展到本轮外议题（如 `countFactorialTerms` 极端整数风险）。