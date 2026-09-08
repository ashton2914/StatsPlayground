# Analysis Distribution 法务复核流程记录

本文件只记录复核请求的流程结构，不提供法律建议、结论或发布授权。

## 记录字段

| 字段 | 约束 |
| --- | --- |
| `artifactId` | 与来源台账关联的稳定机器 ID |
| `status` | `requested`、`inReview`、`closed` 或 `rejected` |
| `requestedAt` | UTC 时间戳 |
| `reviewerRole` | 复核角色代码，不记录个人隐私 |
| `artifactHash` | 被复核 artifact 的 `sha256:` 摘要 |
| `notesHash` | 隔离记录的 `sha256:` 摘要 |

状态变化由组织流程在隔离系统中维护；产品仓库只保存上述代码与摘要。