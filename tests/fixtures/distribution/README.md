# Distribution synthetic seed corpus

该目录只存放自有合成输入的固定种子与摘要，不包含第三方产品输出、截图、文本或原始验证资料。

- `seedId`、`caseId`：稳定机器 ID。
- `seed`：确定性整数种子。
- `inputHash`、`expectedHash`：`sha256:` 摘要。
- `status`：固定为 `synthetic`。

Golden runner 仅比较摘要；相同 seed 和 case ID 必须在所有平台生成相同结果。

Process Capability fixture 是自有 synthetic data 的 machine-only 证据，可以包含固定的 literal observations。fixture 不得包含截图、自由文本、绝对路径或被忽略 source corpus 的路径；正式测试只能读取本目录内 tracked fixture。

公开统计方法计算的 expected values 与第三方产品观察到的 rounded values 必须使用独立字段保存。第三方 observed values 仅用于兼容性评估，不得覆盖或冒充 public-method expected values；证据不足时 `compatibilityStatus` 必须保持 `compatibilityPending`。