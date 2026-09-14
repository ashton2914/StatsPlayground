# 分析功能计算逻辑

本目录是 StatsPlayground 各分析功能计算口径的产品级权威文档。每个方法文档应说明输入、有效观测、分组与顺序、统计公式、区间估计、退化状态、图表换算和方法 provenance。

开发计划和阶段性设计保存在 `docs/superpowers/`；本目录只描述用户实际获得的统计含义，以及已经批准的下一版计算口径。仅保留在兼容层、但当前产品入口不会生成的字段，不作为当前功能语义记录。

## 状态定义

| 状态 | 含义 |
|------|------|
| 已实现 | 当前产品已按该口径计算，并有实现或测试证据 |
| 已批准，待实现 | 产品与统计语义已经确定，但当前版本尚未提供 |
| 待定义 | 产品存在该分析入口，但详细计算口径尚未迁入本目录 |

## 方法目录

| 分析功能 | 方法 | 状态 | 文档 |
|----------|------|------|------|
| Distribution | Normal Individuals Process Capability | 已实现，包含 Nested Subgroup 与 Count Histogram | [Normal Process Capability](normal-process-capability.md) |
| Distribution | Continuous Descriptive Statistics | 待定义 | - |
| Distribution | Continuous Distribution Fit | 待定义 | - |
| Fit Y by X | Oneway / Bivariate methods | 待定义 | - |
| Fit Model | Regression / ANOVA methods | 待定义 | - |
| Hypothesis Test | Registered hypothesis-test methods | 待定义 | - |

## 后续补全文档的最低要求

每个分析功能的计算文档至少覆盖：

1. 方法 ID、版本和实现状态。
2. 输入角色、数据类型、缺失值、筛选、Weight、Frequency 和 By 语义。
3. 样本统计量、模型参数、检验统计量或优化目标的完整公式。
4. 置信区间、自由度、多重比较和数值算法。
5. 空样本、常数列、奇异矩阵、无效参数和非有限结果的状态。
6. 图形数据与坐标轴单位之间的换算。
7. 后端实现、固定 fixture 和兼容性状态的 provenance。
