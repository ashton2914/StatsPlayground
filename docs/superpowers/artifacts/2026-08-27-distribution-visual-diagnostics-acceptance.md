# Distribution Visual Diagnostics V1 验收记录

**日期：** 2026-08-27
**自动验收：** passing
**产品 UI 验收：** pending
**目标版本：** JMP 19 数值兼容

## 方法状态

| 方法 | 状态 | 证据与限制 |
| --- | --- | --- |
| Normal scores | `documentedCompatible` | 官方公式 $p_i=r_i/(N+1)$、$z_i=\Phi^{-1}(p_i)$；覆盖 unique、Freq、大样本与规格邻域 |
| Normal reference line | `compatibilityPending` | 公开实现；缺 JMP 黑盒数值证据 |
| Normal pointwise band | `compatibilityPending` | 公开实现；缺 JMP 黑盒数值证据 |
| JMP Auto Histogram | `compatibilityPending` | 当前明确使用 FD fallback，method ID 不冒充 JMP Auto |
| FD/Scott/Sturges/Fixed Histogram | `intentionalDifference` | 公开可审计方法，不声明 JMP Auto 兼容 |
| Quantile Box | `intentionalDifference` | 公开 letter-value Type-6 方法；UI 显示差异状态 |
| Stem-and-leaf | `intentionalDifference` | 公开 decimal scale 方法；UI 显示差异状态 |
| ECDF | `compatibilityPending` | 后端冻结坐标；JMP Weight/Freq 黑盒矩阵待补 |

## 自动证据

- Compatibility fixture 强制 machine-only schema、稳定 SHA-256、required coverage 与 pending 状态。
- Normal Quantile tests 覆盖 unique、ties、Freq、Weight、small/constant、2000 点上限和规格邻域。
- Histogram tests 覆盖 FD、Scott、Sturges、Fixed count/width、constant、Weight/Freq 与归一化。
- Adapter tests 覆盖 `17445714` count/value extent 隔离、三种 scale、Histogram-only 规格线及三种 Capability 规格线样式。
- Playwright CT 覆盖 Histogram、Box、ECDF、Normal Quantile、Quantile Box、Overview density 与 Capability canvas。
- Workspace CT 覆盖 payload-gated 菜单、默认隐藏、持久化偏好、响应式表格和三行五列 Nonconformance。

## 门禁状态

- `npm run test:distribution`：passing，含 Visual Compatibility、report wiring 与 35 个 Playwright CT。
- `npm run build`：passing。
- `cargo test --lib`：passing，200 个 Rust tests 通过。
- 四语言 JSON parse：passing。
- Tauri smoke：桌面进程响应、Vite HTTP 200。
- `cargo clippy --lib -- -D warnings`：被仓库既有 dead-code/large API lint 基线阻塞；未添加 blanket allow。

## 人工 UI 待验收

1. 真实多 By 数据运行后检查菜单、默认可见性和项目重开恢复。
2. 检查 Overview 的 LSL/Target/USL、Histogram scale、独立 Box 开关及无异常 count 标签。
3. 检查 Normal Quantile、Quantile Box 与 Stem-and-leaf 的状态说明。
4. 检查 Quantiles/Summary 在 `1024x700` 与 `768x900` 的布局和表格线。
5. 检查 Capability 图三种规格线及三行 Nonconformance。

自动测试不得将上述 `uiAcceptance` 更新为 `passed`。
