# Analysis Distribution 来源台账流程记录

本文件仅定义可进入实现仓库的流程元数据字段，不保存原始第三方输出、产品文本、截图、脚本或法律意见。

## 记录字段

| 字段 | 约束 |
| --- | --- |
| `artifactId` | 稳定机器 ID |
| `originKind` | 自有、合成或脱敏来源代码 |
| `allowedFieldKeys` | 允许导出的结构化字段列表 |
| `inputHash` | `sha256:` 前缀的输入摘要 |
| `outputHash` | `sha256:` 前缀的输出摘要 |
| `reviewState` | 流程状态代码 |

## 状态流

`requested` → `screened` → `exported` 或 `rejected`

台账条目不得包含自由文本产品输出、绝对文件路径或未摘要的来源材料。