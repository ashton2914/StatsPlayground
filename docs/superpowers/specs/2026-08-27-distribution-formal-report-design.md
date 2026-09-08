# Distribution 正式报告与自适应工作区设计

**日期：** 2026-08-27
**状态：** 已批准
**依赖规格：**
- [Distribution Platform Workflow V1](2026-08-26-distribution-platform-workflow-v1.md)
- [Continuous Descriptive Methods V1](2026-08-26-distribution-continuous-descriptive-methods-v1.md)
- [Normal Process Capability V1](2026-08-26-distribution-normal-capability-method-v1.md)

## 1. 目标

把当前 Distribution 的最小配置对话框和扁平报告骨架升级为可在固定尺寸 Tauri 窗口中完整操作、浏览和验收的正式分析工作区：

1. 配置界面不因窗口宽度压缩文字或产生横向滚动。
2. 报告按 `Overall/By group -> Y column -> report block` 呈现，并支持折叠。
3. Overview 将后端预计算的 Histogram 与 Tukey Box 组合渲染；ECDF 作为可选分析。
4. Quantiles、Core Summary 与 Mean CI 完整显示 typed availability。
5. Y 列存在有效 `LSL` 或 `USL` 时，自动生成 Normal Individuals Process Capability。
6. 所有统计值由后端生成；React 与 Graph Builder 只组织和渲染。

## 2. 配置工作区

### 2.1 响应式规则

- 对话框使用 `min(1120px, viewport - 32px)` 的最大宽度，但不设置超过 viewport 的固定最小宽度。
- 宽度大于 `900px`：左侧列浏览器，右侧 2x2 角色区。
- 宽度小于等于 `900px`：列浏览器、Y、Weight、Frequency、By 全部纵向排列。
- Assigned column chip 允许整体换行，但列名内部不逐字符断行；超长列名使用省略号和 title。
- Dialog header 与 footer 固定，只有中间内容区滚动。
- Save、Run、Cancel 始终可见。

### 2.2 角色说明

- `Y`：分析的连续数值列，可多选。
- `Weight`：每行权重，只允许数值列，单选。
- `Freq`：每行代表的重复次数，只允许整数兼容列，单选。
- `By`：拆分报告的分组列，可多选。

按钮与拖放使用同一兼容性规则；不允许先放入非法角色再等待 Save 校验失败。

## 3. 报告信息架构

```text
Distribution analysis
├─ Overall
│  └─ sales_amount
│     ├─ Overview: horizontal Histogram + Tukey Box
│     ├─ Quantiles
│     ├─ Summary Statistics
│     └─ Process Capability (有有效规格限时)
│        ├─ Capability Histogram
│        ├─ Process Summary
│        ├─ Within Sigma Capability
│        ├─ Overall Sigma Capability
│        └─ Nonconformance
├─ region = East
├─ region = West
└─ region = Missing
```

- 即使配置了 By，后端也必须生成忽略 By 分区的 Overall 结果，并将其置于所有 By groups 之前；应复用同一次数据物化，不能为 Overall 再执行一次数据查询。
- Overall、By group 与 Y section 使用可折叠 disclosure。
- Overall 与其第一个 Y 默认展开，By groups 默认折叠以控制长报告。
- Workspace header 和 Run/Edit controls 为 sticky；报告正文独立纵向滚动。
- 报告不得因为固定窗口高度隐藏尾部数据。
- `Histograms Only` 仅输出 Histogram block，隐藏其余描述和 capability block。
- 每个 Y 标题提供分析显示菜单：Overview、Quantiles、Summary Statistics 默认开启，Empirical CDF 默认关闭，有有效规格限时 Process Capability 默认开启。
- Process Capability 标题提供子模块显示菜单，只列出已实现的 Capability Histogram、Process Summary、Within Sigma Capability、Overall Sigma Capability 和 Nonconformance。

## 4. Continuous 报告

### 4.1 Quantiles

显示批准概率点：`0, 0.005, 0.025, 0.10, 0.25, 0.50, 0.75, 0.90, 0.975, 0.995, 1`。

使用紧凑三列表格 `Probability / Label / Value`；`Minimum / Quartile / Median / Maximum` 提供语义标签，数值右对齐并使用 tabular numerals。

### 4.2 Summary Statistics

显示：

- N、N Missing
- Mean、Std Dev、Std Error
- Mean CI lower/upper
- Minimum、Maximum、Median、Mode
- Range、IQR、MAD

不可用字段显示稳定 reason 的本地化文案，不以空白或裸 null 表示。

表格按 Location 与 Variation 分组为紧凑的双栏统计布局，避免把字段展开为宽屏卡片网格。

### 4.3 图表

- Overview：横向 Histogram 与 Tukey Box 并排、共享垂直数值轴；后端冻结 bins、quartiles、whiskers 和 outliers，前端不 re-bin。
- Histogram count 轴范围取 `max(bin.count)`；数值轴覆盖 bins、whiskers、outliers 及启用的规格线，不能把 bin 边界误作 count 范围。
- ECDF：后端冻结 step coordinates，默认隐藏，可从 Y 分析显示菜单启用。
- chart-data 必须先通过 `toGraphBuilderInput()`，再由 graphCore renderer 渲染。
- 不新增一套 Distribution 专用统计或 bin math。

## 5. Normal Process Capability

- 后端按稳定 dataset/column UUID 获取权威列属性 `extras.spec.lsl/target/usl`。
- 至少存在有效 LSL 或 USL 时自动生成 capability block。
- Target-only 不启用。
- Analysis override 按字段覆盖列属性，不回写 Table。
- Weight/Freq 存在时 capability block 显示 unavailable；Continuous 报告继续运行。
- 输出 Process Summary、Within/Overall indices、intervals、Observed/Expected nonconformance、PPM 与 capability chart-data。
- 图表显示 Histogram、LSL/Target/USL、Overall density，Within density 可切换。
- Process Capability 使用独立子树；各子模块可从标题菜单显示或隐藏，但菜单不得暴露未实现或未批准的第三方分析功能。

## 6. 状态与滚动

- `running/updating`：旧有效报告保留，header 显示进度。
- `failed/cancelled/stale`：旧报告保留并显示状态原因。
- `missingSource`：禁止 Run，可通过 Edit Inputs 重新绑定。
- unknown/corrupt：只读，不渲染未知 payload 为报告。
- 结果区使用 `min-height: 0; overflow: auto`，禁止依赖页面整体滚动。

## 7. 可访问性与本地化

- 折叠标题使用原生 `button` + `aria-expanded`。
- 图表具有可访问名称与数值表格替代。
- 所有用户可见文本进入 `en/zh-CN/zh-TW/vi`。
- 数值表格使用 tabular numerals，窄窗口可纵向滚动但不截断字段名。

## 8. 验收

自动验收至少覆盖：

1. `768x900` 和 `1024x700` 下配置区无水平溢出、无逐字符断行。
2. 多 By、多 Y 时 Overall 始终第一、By group 顺序稳定，以及各层折叠行为。
3. 报告容器能滚动到最后一个 block。
4. 组合 Overview 与可选 ECDF canvas 非空且 chart-data 无重算；ECDF 默认隐藏。
5. Quantiles 与 Summary 数值合同。
6. 有/无/单侧/双侧规格限的 capability block 状态。
7. Weight/Freq 时 capability unavailable。
8. save/open 后规格 override 与 column UUID 保持。

正式 UI 验收必须在 Tauri 应用中执行，自动测试不得直接把 `uiAcceptance` 标为 passed。
