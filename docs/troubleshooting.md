# 排错笔记

记录在 StatsPlayground 开发过程中遇到并解决的几个有代表性的问题。每条都包含 **现象 → 根因 → 修复 → 余下风险点**，方便以后排查类似情况。

---

## 目录

- [1. `Math.min/max(...arr)` 在大数组上抛 RangeError 并白屏](#1-mathminmaxarr-在大数组上抛-rangeerror-并白屏)
- [2. DualListPicker Shift 多选会单选 / 越界 / 白屏](#2-duallistpicker-shift-多选会单选--越界--白屏)
- [3. React Hooks 顺序 —— `if (!data) return` 之后不能再放 hook](#3-react-hooks-顺序--if-data-return-之后不能再放-hook)
- [4. ECharts axis drag-zoom：从"飞走"到"丝滑"踩到的几个坑](#4-echarts-axis-drag-zoom从飞走到丝滑踩到的几个坑)
- [5. `findIndex((c) => c.name === ...)` 在 `string[]` 上静默返回 -1](#5-findindexc--cname----在-string-上静默返回--1)
- [6. Workflow rerun 报 `determinismViolation` 或保存后未显示输出](#6-workflow-rerun-报-determinismviolation-或保存后未显示输出)
- [附录：通用排查思路](#附录通用排查思路)

---

## 1. `Math.min/max(...arr)` 在大数组上抛 RangeError 并白屏

### 现象

- 在 `DataTableView` 里：
  - 列表头 Shift 多选几百列 × 几百行，或者
  - 左侧"列列表"侧栏 Shift 多选大量列
- 窗口瞬间变 **全白**。
- DevTools 控制台首条红字：
  ```
  Uncaught RangeError: Maximum call stack size exceeded
      at DataTableView.tsx:1015
  ```
- 紧随其后的 React 提示 `An error occurred in the <DataTableView>` 只是**通用兜底**，不是真正异常。

### 根因

`Math.min(...arr)` / `Math.max(...arr)` 会把数组里**每个元素**作为一个函数实参传入。当 `arr.length` 进入 10⁵ 量级时，V8 的**函数实参个数上限**被击穿，抛 `RangeError: Maximum call stack size exceeded`。

工程里没有顶层 `ErrorBoundary`，所以这种渲染期/effect 期未捕获异常会让 React 把整棵子树卸载 —— 表现就是"白屏"。

### 修复模板

用一次性 `for` 循环同时求出 `sum / min / max`，对任意大的数组都安全，而且比 `reduce + 两次 spread` 更快：

```ts
let sum = 0;
let min = Infinity;
let max = -Infinity;
for (let i = 0; i < nums.length; i++) {
  const n = nums[i];
  sum += n;
  if (n < min) min = n;
  if (n > max) max = n;
}
```

### 已修复位置

| 文件 | 行号 (修复前) | 场景 |
|------|--------------|------|
| `src/components/DataTableView.tsx` | ~1015 | 选区状态栏统计 (sum / min / max) |
| `src/components/DataTableView.tsx` | ~3424 | 批量列属性"Auto"按钮的列宽计算 |
| `src/graphCore/transform.ts` | 169-170 | `histogramBins` 求 min/max |
| `src/graphCore/transform.ts` | 579-580 | 箱线图 outlier 分支计算上下须 |
| `src/graphCore/transform.ts` | 896-897 | 散点图 size 编码归一化 |

对应提交：`8246b3a`、`c46f02d`。

### 同类风险

只要往**函数实参里 spread**了一个长度由用户数据决定的数组，都有同样风险。未来代码评审需要警惕：

- `Math.min(...arr)` / `Math.max(...arr)`
- `String.fromCharCode(...arr)`
- `arr.push(...other)`（其中 `other` 长度无上限）
- 任何 `f(...largeArr)` 形式

实际限制因引擎/平台而异 (V8 默认约 ~65535 个参数)，但**任何"可能很大"的数组都不要 spread**。

---

## 2. DualListPicker Shift 多选会单选 / 越界 / 白屏

`DualListPicker` 是 `Subset / Summary / Split / Update` 几个表操作对话框共用的 JMP 风格列选择器。

### 现象

复现路径：

1. 单击一列；
2. 拖滚动条到列表很下方；
3. 按住 Shift 点击另一列想多选 ——
   - 有时只选中**新点击的那一列**（单选）；
   - 有时窗口**白屏**。

### 根因

旧实现把 **数组下标 (index)** 缓存为 Shift 选择的 anchor。但 anchor 之后 `items` 数组可能被父组件刷新（搜索、过滤、外部 state 同步），下标含义改变 —— anchor 要么指向了不同的项（造成奇怪的多选），要么落到了越界位置（在某些路径下抛出错误，再叠加上一节的 `RangeError` 一起白屏）。

### 修复要点

- **以 key 而非 index 作为 anchor**：缓存 `lastLeftClickRef` / `lastRightClickRef` 存的是 `item.key`。
- **`useEffect([items])` 在 items prop 变化时重置 anchor**，避免 stale anchor 越界。
- **Shift 时 anchor 找不到** → 退化为"已选项中离当前点击点最近的一项"作为 anchor，至少给出合理多选区间，不再单选。
- **`handlePaneClick` 整段裹 try/catch**：极端情况捕获并清掉 anchor，绝不让事件回调把整棵 React 子树拖下水。
- **忽略非主键鼠标按钮**：右键/中键不再触发选择逻辑。
- **CSS 加 `user-select: none`** (`.sp-dlp-list`, `.sp-dlp-list-item`)：Shift 多选时不再连带选中文字。

对应提交：`1559406`、`79e3458`。

### 复现验证

修复后，重新在长列表里 Shift 多选大量项：
- 不再单选；
- 不再白屏；
- 文字不会被选中。

---

## 3. React Hooks 顺序 —— `if (!data) return` 之后不能再放 hook

### 现象

`data: null → loaded` 切换的一瞬间窗口白屏，DevTools 报 hooks 数量发生变化 / order changed。

### 根因

`DataTableView.tsx` 中有：

```tsx
if (!data) return <div>{t("dataTable.loading")}</div>;
```

如果在这一行**之后**再调用任何 hook (`useState` / `useEffect` / `useMemo` / `useCallback` / `useRef`)，则：

- `data === null` 时 React 看到 N-1 个 hook；
- `data` 加载完后 React 看到 N 个 hook；
- 两次渲染 hook 数量不一致 → React 抛错 → 整棵子树卸载 → 白屏。

### 规则

> 在 `if (!data) return ...` 这一行**之前**，必须把所有 hook 调用全部声明好。条件返回之后**一行 hook 都不能加**。

历史上这个 bug 已经在 `useRef` / `useEffect` / `useMemo` 上各重犯过一次，**编辑 `DataTableView.tsx` 时务必检查**。

---

## 4. ECharts axis drag-zoom：从"飞走"到"丝滑"踩到的几个坑

JMP 风格的"在轴上拖拽缩放 / 平移"看起来就是几行 `setOption`，但实现过程中陆续踩了 5 个坑。每个症状都很相似（**不跟手 / 跳变 / 卡顿**），根因却各不一样，按以下顺序排查最高效。

### 4.1 ZRender 事件不可靠 → 用原生 PointerEvent + setPointerCapture

**现象**：拖到一半松开鼠标，画布以为还在拖；或者拖出画布外再松开，事件丢失，光标"卡住"在 `grabbing`。

**根因**：`inst.getZr().on("mousedown", ...)` 在跨 iframe / 失焦 / DevTools 偷焦时会丢 `mouseup`。

**修复**：直接在容器 DOM 上注册 `pointerdown / pointermove / pointerup / pointercancel`，跨过 3 px 阈值后调用 `el.setPointerCapture(pointerId)`。再加一道 `window` 级 `mouseup` 兜底，即便 capture 失败也能正常释放。

### 4.2 残留的显式 `interval` 让刻度密度左右不对称

**现象**：往一个方向拖只有 5 条刻度线，反方向拖突然变成 30+ 条。

**根因**：基础 option 里写了 `interval: fit.interval`（按**原始数据范围**算出的步长）。`setOption` 的 merge 会保留这个 `interval`，但 `min/max` 已经被拖到新范围 —— 范围放大时 step 太小、缩小时 step 太大。

**修复**：基础 option **不要写 `interval`**，让 ECharts 在每次 `min/max` 变化时自动重算"漂亮"的 tick step。只有用户在对话框里显式指定 `tickInterval` 时才下发 `interval`。

### 4.3 Snap-to-grid 让画面只在跨过刻度线时才动

**现象**：鼠标连续移动，画面却一段一段地跳；像卡顿其实是离散步进。

**根因**：为了让 tick label 永远落在"漂亮"的数字（0.1, 0.2, 0.3）上，把 `min` 也四舍五入到 step 的倍数。结果只有当鼠标跨过半个 step（~20 px）时画面才更新。

**修复**：根本不用 snap —— ECharts 的 auto-tick 已经会在 `[min, max]` 里挑漂亮位置（`{1, 2, 5} × 10^k` 的倍数），跟 `min` 是不是整数无关。bounds 连续跟随光标即可。

### 4.4 120 Hz pointer 事件把 setOption 压垮

**现象**：拖动手感整体偏黏，越快越糊。

**根因**：高刷鼠标 `pointermove` 触发 120-240 次/秒，每次都同步 `setOption`，ECharts 来不及合帧。

**修复**：用 `requestAnimationFrame` 合并到每帧最多一次 `setOption`，再加 `{ lazyUpdate: true, silent: true }`：

```ts
let pendingPatch = null, scheduledFrame = 0;
const flushPatch = () => {
  scheduledFrame = 0;
  if (!pendingPatch) return;
  inst.setOption({ ...pendingPatch, animation: false }, { lazyUpdate: true, silent: true });
  pendingPatch = null;
};
// pointermove handler:
pendingPatch = patch;
if (!scheduledFrame) scheduledFrame = requestAnimationFrame(flushPatch);
```

记得在 `finishDrag` / `useEffect` cleanup 里 `cancelAnimationFrame` 并 flush 最后一帧，否则提交的 bounds 会比最后渲染的差一帧。

### 4.5 ECharts 默认的 update tween 让形状滞后游标 ~300 ms

**现象**：折线图的折线实时跟手，但同一张图里的散点、箱线图矩形、坐标轴标签全部慢半拍 —— 给人"画面比鼠标慢半秒"的错觉。

**根因**：`animationDurationUpdate` 默认 ~300 ms。每帧 `setOption` 重新触发一次 300 ms 的 tween：每个形状还在补完上一帧的 tween，又被告知去新的目标 → 永远在追逐光标。折线之所以例外，是因为 ECharts 直接根据投影点重画 path 的 `d`，**没有 per-shape transform 动画**。

**诊断技巧**：如果**只有 line 类系列跟手、其它形状滞后**，几乎可以肯定是 update animation 在作祟，**不要先去找 setOption 性能问题**。

**修复**：拖动时 patch 里加 `animation: false`（见 4.4 代码）。松手后父组件触发的 `setOption(option, true)`（`notMerge=true`）会把 `animation` 恢复到默认值，正常的对话框编辑还是带动画的。

### 4.6 附带的相关坑：`axisLine.onZero` 让坐标轴跟着数据 0 漂

**现象**：把 0 拖到画面上方后，X 轴轴线也跟着浮到了中间，整张图的"边框"在数据里乱串。

**根因**：ECharts 的 `xAxis.axisLine.onZero` 默认 `true` —— 把 X 轴线钉在数据 `y=0`，可见范围里有 0 时就跟 0 走（`yAxis` 同理）。

**修复**：`buildAxisCommon` 里给 `axisLine` 加 `onZero: false`，把坐标轴线永远固定在 grid 的下边 / 左边（chart-frame 风格，跟 JMP / Plotly / matplotlib 一致）。

### 通用经验

- 任何"自动布局"的库（ECharts、AG-Grid …）在**高频实时交互**场景下，都要专门检查它的 **animation / batching / event-dispatch** 开关；默认值往往是为"低频更新 + 漂亮过渡"调的。
- 排查"画面跟不上"的标准顺序：① 是不是离散步进？② 是不是事件被压垮？③ 是不是有看不见的 tween？前两条治输入，第三条治输出。
- 不同系列类型对动画的敏感度差很多 —— **拿 line 当对照组**最容易区分"渲染慢"和"动画慢"。
- 不要在 base option 里塞计算出来的"派生值"（`interval`、`onZero` 隐式默认、tick 起点等）—— `setOption` 的 merge 语义会让这些值在用户改了上游 bounds 之后继续存活，制造一类很难被一眼看出来的"幽灵设置"。

---

## 5. `findIndex((c) => c.name === ...)` 在 `string[]` 上静默返回 -1

### 现象

修了一发"facet 时丢掉完全空的子面板"（commit `662bd38`），跑起来**完全没生效**：`Build=EV2` 的子面板 Y 全是 NaN，但还是占着一格网格、把其它面板挤窄。`vite build` 没报错，TS 没报错，但功能就是不工作 —— 滤掉空面板的代码像没执行一样。

### 根因

辅助函数原本写成：

```ts
function hasPlottableRows(
  rows: GraphData["rows"],
  encoding: GraphSpec["encoding"],
  columns: GraphData["columns"],   // ← string[]，不是 {name}[]
): boolean {
  if (rows.length === 0) return false;
  const yIdx = encoding.y
    ? columns.findIndex((c) => c.name === encoding.y!.name)   // ← 永远 -1
    : -1;
  if (yIdx >= 0) {
    return rows.some((r) => Number.isFinite(toNum(r[yIdx])));
  }
  // …xIdx 同理…
  return true;   // ← 永远走这里
}
```

`GraphData.columns` 定义是 `string[]`（[`types.ts`](../src/graphCore/types.ts) 里那一行），不是 `{name: string}[]`。但：

- `findIndex` 接受**任意**谓词函数，类型不会报错；
- 谓词体内 `c` 类型是 `string`，读 `c.name` —— JS 允许在任意 string / Number / Boolean 上读不存在的属性，**返回 `undefined`，不抛错**；
- `undefined === "EV2"` 永远 `false` → `findIndex` 返回 `-1`；
- `yIdx === -1`，跳过那个分支；`xIdx` 同样 `-1`；
- 最后命中 fallback `return true` —— **任何**非空 row 子集都被判为 "有数据"，空面板永远不会被滤掉。

整个滤空函数变成了一个昂贵的 no-op。TS 看不出来 ——`c.name` 在 `string` 上的访问是合法语法（任意 JS 值都能读属性），编译器不会拦。

### 修复

工程里**早就**有一个正确的列查找助手 `colIndex(data, name)`（[`transform.ts`](../src/graphCore/transform.ts) 里），内部就是 `data.columns.indexOf(name)`。换成它即可：

```ts
function hasPlottableRows(
  rows: GraphData["rows"],
  encoding: GraphSpec["encoding"],
  data: GraphData,   // ← 整个 data，方便用 colIndex
): boolean {
  if (rows.length === 0) return false;
  // NOTE: GraphData.columns 是 string[]，不是 {name}[] —— 必须用
  // colIndex（基于字符串相等），不能 inline 写 findIndex(c => c.name…)，
  // 那样在 string 数组上永远返回 -1，整个 helper 就变成 no-op。
  const yIdx = encoding.y ? colIndex(data, encoding.y.name) : -1;
  if (yIdx >= 0) {
    return rows.some((r) => Number.isFinite(toNum(r[yIdx])));
  }
  const xIdx = encoding.x ? colIndex(data, encoding.x.name) : -1;
  if (xIdx >= 0) {
    return rows.some((r) => Number.isFinite(toNum(r[xIdx])));
  }
  return true;
}
```

对应提交：`9bf5434`。

### 教训 / 规则

- **针对 `GraphData` 找列，永远先看有没有现成的 `colIndex(data, name)`**，不要 inline 写 `findIndex`。`columns` 是扁平 `string[]`，约定如此。
- **TS 不会替你抓"读不存在的属性"**。`obj.foo` 在 `obj` 类型为 `string | number | boolean` 时是合法的（值类型都有原型方法），编译器只在显式 `never`、`null`、`undefined` 上才会报错。
- 谓词函数对 `findIndex` / `filter` / `some` 永远返回 boolean，**找不到目标"看起来是空集合"和"谓词永远 false"完全等价**。这意味着：写法上出错的过滤器会安静退化成"全保留"或"全丢弃"，需要的是单元测试或在 helper 顶上加一条断言（"yIdx 必须 >=0，否则警告"）才能立刻发现。
- 写完一个**应该会滤掉东西**的函数后，最简单的回归就是手动找一个**已知应被滤掉**的输入，确认它真的被滤掉 —— 而不是只看 build 通过和大致跑起来。

### 同类风险

整段代码库里所有针对 `GraphData.columns` 的查找都应该用 `colIndex`。复查命令：

```powershell
# 任何在 .columns 上 inline 写 findIndex(c => c.name === ...) 的地方都要警惕
Select-String -Path src/graphCore/*.ts,src/components/**/*.tsx `
  -Pattern 'columns\.findIndex\([^)]*\.name'
```

如果命中**任何**结果，立刻换成 `colIndex(data, name)`。

---

## 6. Workflow rerun 报 `determinismViolation` 或保存后未显示输出

### `determinismViolation`

当 Workflow revision、输入 fingerprints、规范化配置、seed、engine version 和 stable output bindings 都与某个成功 run 相同时，rerun 的 output fingerprints 必须完全一致。若不一致，backend 返回 `determinismViolation`，删除本轮 staging 数据，并保留上一次成功输出。

排查时先比较失败 run 与 `determinismBaselineRunId` 指向 run 的输入 generation/content hash、配置 hash和engine version；这些字段相同而output hash不同，才是执行器的确定性缺陷。不要通过清空历史或忽略hash来绕过。

### backend 已完成但界面未显示

成功 Table publication 与 frontend 可见commit之间使用backend journal衔接。若应用在frontend acknowledge前关闭，重新打开**同一路径的项目文件**会恢复stable Table并重放未确认packet。恢复后确认run history只出现一次；commit ID使重复replay幂等。

如果没有恢复，依次检查：打开的是否为同一项目、项目是否在执行前已有保存路径、run是否为`succeeded`、journal packet是否已经被acknowledge。failed/blocked run不会被恢复成成功输出。

---

## 附录：通用排查思路

### "白屏" 出现时怎么定位

1. **打开 DevTools Console**。
2. **找最上面那条红色 `Uncaught ...`**，而不是 React 的 `"An error occurred in <Xxx>"` 通用提示 —— 后者只指出"最近的组件树位置"，不是真正抛错点。
3. 把红字里的 **`xxx.tsx:行号`** 直接定位到源码。
4. 如果错误是 `Maximum call stack size exceeded` 且发生在数据/统计相关 effect 里，**优先怀疑 `Math.min/max(...)`** 之类的 spread anti-pattern。

### 这个工程目前没有顶层 ErrorBoundary

只要某次渲染或 effect 抛出**未捕获**异常，React 就会卸载整棵子树。这意味着：

- 任何形式的 unbounded operation（参数数量、递归深度、内存）都会被放大成"整窗白屏"。
- 写涉及大数据的代码时要**主动**用 `for` 循环、批处理、`requestIdleCallback` 等防御技巧，而不是依赖框架兜底。

如有需要，后续可在 `Workspace.tsx` 顶层加一个简单的 ErrorBoundary，把异常 fallback 成可读错误页，避免一直裸奔。
