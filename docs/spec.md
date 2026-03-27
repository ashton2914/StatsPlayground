# StatsPlayground — 系统架构与开发规范

> An ultra-lightweight, open-source, and extensible data analysis tool.

---

## 目录

1. [项目概述](#1-项目概述)
2. [核心定位与竞争优势](#2-核心定位与竞争优势)
3. [技术栈概览](#3-技术栈概览)
4. [系统架构总览](#4-系统架构总览)
5. [后端架构 (Rust / Tauri)](#5-后端架构-rust--tauri)
6. [数据引擎层 (DuckDB)](#6-数据引擎层-duckdb)
7. [前端架构 (Vite + React)](#7-前端架构-vite--react)
8. [前后端通信协议](#8-前后端通信协议)
9. [核心功能模块](#9-核心功能模块)
10. [项目目录结构](#10-项目目录结构)
11. [开发规范](#11-开发规范)
12. [构建与发布](#12-构建与发布)
13. [路线图](#13-路线图)

---

## 1. 项目概述

StatsPlayground 是一款轻量级、跨平台、开源的数据分析软件，目标对标 JMP Pro，为科研人员、数据分析师和工程师提供专业的统计分析与数据可视化能力。

### 1.1 对标 JMP Pro 的功能域

| JMP Pro 功能域 | StatsPlayground 对应模块 | 优先级 |
|---------------|------------------------|--------|
| 数据表管理 | DataTable 模块 | P0 |
| 数据导入/导出 (CSV, Excel, DB) | DataIO 模块 | P0 |
| 描述性统计 | Stats.Descriptive 模块 | P0 |
| 数据可视化 (交互式图表) | Visualization 模块 | P0 |
| 假设检验 | Stats.Hypothesis 模块 | P1 |
| 回归分析 | Stats.Regression 模块 | P1 |
| 方差分析 (ANOVA) | Stats.ANOVA 模块 | P1 |
| 试验设计 (DOE) | DOE 模块 | P2 |
| 预测建模 (决策树、神经网络等) | Modeling 模块 | P2 |
| 质量与可靠性分析 | Quality 模块 | P2 |
| 脚本语言 (JSL) | Scripting 模块 | P3 |

---

## 2. 核心定位与竞争优势

| 维度 | JMP Pro | StatsPlayground |
|------|---------|-----------------|
| 平台 | Windows / macOS | Windows / macOS / Linux |
| 体积 | ~2 GB+ | 目标 < 50 MB |
| 授权 | 商业付费 (~$1,785/年) | MIT 开源 |
| 数据引擎 | 内置引擎 | DuckDB (列式分析引擎) |
| 扩展性 | JSL 脚本 | 插件系统 + 脚本支持 |
| 大数据量支持 | 受内存限制 | DuckDB 磁盘模式 + 流式查询 |

---

## 3. 技术栈概览

```
┌─────────────────────────────────────────────────────┐
│                    用户界面层                         │
│         Vite + React + TypeScript                    │
│    UI: Ant Design / Radix    Charts: ECharts / D3    │
├─────────────────────────────────────────────────────┤
│                  前后端通信层                         │
│           Tauri IPC (invoke / events)                │
├─────────────────────────────────────────────────────┤
│                   后端核心层                          │
│              Tauri v2 (Rust)                         │
│   ┌──────────┬──────────┬──────────┬──────────┐     │
│   │ 数据引擎  │ 统计计算  │ 文件 I/O │ 插件系统  │     │
│   │ DuckDB   │ nalgebra │ calamine │ Plugin   │     │
│   │          │ statrs   │ csv      │ Manager  │     │
│   └──────────┴──────────┴──────────┴──────────┘     │
├─────────────────────────────────────────────────────┤
│                   操作系统层                          │
│          Windows / macOS / Linux                     │
└─────────────────────────────────────────────────────┘
```

| 层 | 技术 | 用途 |
|----|------|------|
| 前端框架 | React 19+ / TypeScript | UI 渲染与交互 |
| 构建工具 | Vite 6+ | 前端构建与 HMR |
| UI 组件库 | Ant Design 5 / Radix UI | 表格、表单、布局组件 |
| 图表引擎 | ECharts 5 / D3.js | 统计图表与交互式可视化 |
| 数据表格 | AG Grid (Community) / TanStack Table | 高性能数据表格 |
| 桌面框架 | Tauri v2 | 跨平台桌面容器 |
| 后端语言 | Rust | 系统级后端逻辑 |
| 数据引擎 | DuckDB (via duckdb-rs) | SQL 分析查询引擎 |
| 统计计算 | statrs / nalgebra / ndarray | 统计分布、线性代数、矩阵运算 |
| 文件解析 | calamine (Excel) / csv / arrow | 多格式数据导入导出 |

---

## 4. 系统架构总览

### 4.1 整体数据流

```
用户操作 (UI)
    │
    ▼
┌──────────────────────────┐
│   React 前端              │
│   - 数据表格视图           │
│   - 分析面板              │
│   - 可视化画布             │
└──────────┬───────────────┘
           │ Tauri invoke / events
           ▼
┌──────────────────────────┐
│   Tauri Rust 后端         │
│   ┌────────────────────┐ │
│   │  Command Router    │ │  ← Tauri Commands 分发层
│   └────────┬───────────┘ │
│            ▼             │
│   ┌────────────────────┐ │
│   │  Service Layer     │ │  ← 业务逻辑层
│   │  - DataService     │ │
│   │  - StatsService    │ │
│   │  - IOService       │ │
│   │  - ProjectService  │ │
│   └────────┬───────────┘ │
│            ▼             │
│   ┌────────────────────┐ │
│   │  Engine Layer      │ │  ← 引擎层
│   │  - DuckDB Engine   │ │
│   │  - Stats Engine    │ │
│   │  - Plugin Engine   │ │
│   └────────────────────┘ │
└──────────────────────────┘
           │
           ▼
┌──────────────────────────┐
│   文件系统 / 用户数据      │
│   - .duckdb 数据库文件    │
│   - 项目文件 (.spg)      │
│   - 导出文件             │
└──────────────────────────┘
```

### 4.2 核心设计原则

1. **前端无状态数据**：所有数据存储在 DuckDB 中，前端仅持有当前视图的分页数据
2. **SQL 驱动分析**：尽量将计算下推到 DuckDB SQL 层，利用其列式引擎和向量化执行
3. **异步非阻塞**：大型计算操作通过 Tauri 异步 Command 执行，通过 Event 推送进度
4. **模块化隔离**：各功能模块通过 Service trait 解耦，支持独立测试和替换

---

## 5. 后端架构 (Rust / Tauri)

### 5.1 模块划分

```
src-tauri/src/
├── main.rs                 # Tauri 入口 / 应用初始化
├── lib.rs                  # 模块注册
├── commands/               # Tauri Command 定义（前端调用入口）
│   ├── mod.rs
│   ├── data_commands.rs    # 数据操作命令
│   ├── stats_commands.rs   # 统计分析命令
│   ├── io_commands.rs      # 文件导入导出命令
│   ├── project_commands.rs # 项目管理命令
│   └── viz_commands.rs     # 可视化数据命令
├── services/               # 业务逻辑层
│   ├── mod.rs
│   ├── data_service.rs     # 数据表管理
│   ├── stats_service.rs    # 统计计算
│   ├── io_service.rs       # 文件 I/O
│   └── project_service.rs  # 项目状态管理
├── engine/                 # 引擎层
│   ├── mod.rs
│   ├── duckdb_engine.rs    # DuckDB 连接与查询管理
│   └── stats_engine.rs     # 统计算法实现
├── models/                 # 数据模型与类型定义
│   ├── mod.rs
│   ├── table.rs            # 数据表模型
│   ├── column.rs           # 列元数据
│   ├── stats.rs            # 统计结果模型
│   └── project.rs          # 项目模型
├── plugins/                # 插件系统
│   ├── mod.rs
│   └── manager.rs          # 插件生命周期管理
├── error.rs                # 统一错误类型
└── state.rs                # 应用全局状态 (Tauri State)
```

### 5.2 全局状态管理

使用 Tauri 的 `State` 机制管理全局状态：

```rust
/// 应用全局状态
pub struct AppState {
    /// DuckDB 连接池
    pub db: Mutex<duckdb::Connection>,
    /// 当前打开的项目信息
    pub project: RwLock<Option<ProjectInfo>>,
    /// 插件注册表
    pub plugins: RwLock<PluginRegistry>,
}
```

### 5.3 错误处理

定义统一的错误枚举，所有 Tauri Command 返回 `Result<T, AppError>`：

```rust
#[derive(Debug, thiserror::Error, serde::Serialize)]
pub enum AppError {
    #[error("数据库错误: {0}")]
    Database(String),
    #[error("文件错误: {0}")]
    FileIO(String),
    #[error("统计计算错误: {0}")]
    Stats(String),
    #[error("参数错误: {0}")]
    InvalidParam(String),
}
```

### 5.4 Tauri Command 设计样例

```rust
#[tauri::command]
async fn query_table(
    state: tauri::State<'_, AppState>,
    table_name: String,
    page: usize,
    page_size: usize,
    sort_by: Option<String>,
    filter: Option<String>,
) -> Result<TableQueryResult, AppError> {
    let service = DataService::new(&state);
    service.query_table(&table_name, page, page_size, sort_by, filter).await
}
```

---

## 6. 数据引擎层 (DuckDB)

### 6.1 为何选择 DuckDB

| 特性 | 说明 |
|------|------|
| 嵌入式 | 无需独立进程，以库形式链接到应用中 |
| 列式存储 | 针对分析查询优化，聚合/扫描极快 |
| SQL 完整支持 | 标准 SQL + 窗口函数 + CTE + PIVOT |
| 多格式直读 | 直接查询 CSV / Parquet / JSON 文件，无需先导入 |
| 零配置 | 无需安装、无需管理，开箱即用 |
| 内存 + 磁盘模式 | 小数据纯内存，大数据自动溢出到磁盘 |

### 6.2 数据表管理策略

```sql
-- 每个用户导入的数据集创建为 DuckDB 表
CREATE TABLE dataset_{id} AS SELECT * FROM read_csv('path/to/file.csv');

-- 元数据表：记录所有数据集的信息
CREATE TABLE _meta_datasets (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    source_path TEXT,
    source_type TEXT,       -- csv / excel / parquet / manual
    row_count   BIGINT,
    col_count   INTEGER,
    created_at  TIMESTAMP DEFAULT current_timestamp,
    updated_at  TIMESTAMP DEFAULT current_timestamp
);

-- 列元数据表
CREATE TABLE _meta_columns (
    dataset_id  TEXT REFERENCES _meta_datasets(id),
    col_index   INTEGER,
    col_name    TEXT,
    col_type    TEXT,       -- DuckDB 类型
    role        TEXT,       -- continuous / nominal / ordinal / id
    missing_count BIGINT,
    PRIMARY KEY (dataset_id, col_index)
);
```

### 6.3 查询执行模式

```
前端请求 (分页/筛选/排序)
        │
        ▼
┌─────────────────────┐
│   SQL Query Builder  │  ← 根据请求构建安全的参数化 SQL
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│      DuckDB         │  ← 执行查询
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│   Arrow RecordBatch  │  ← 以 Arrow 格式返回结果
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│   JSON Serialize     │  ← 序列化为 JSON 传递给前端
└─────────────────────┘
```

> **安全注意**：所有用户输入的查询条件必须使用参数化查询（prepared statements），严禁字符串拼接 SQL。

---

## 7. 前端架构 (Vite + React)

### 7.1 目录结构

```
src/
├── main.tsx                    # 应用入口
├── App.tsx                     # 根组件 / 路由
├── assets/                     # 静态资源
├── components/                 # 通用 UI 组件
│   ├── common/                 # 按钮、对话框、工具栏等
│   ├── data-table/             # 数据表格组件
│   ├── chart/                  # 图表组件
│   └── layout/                 # 布局组件（菜单栏、侧栏、面板）
├── features/                   # 功能模块（按业务域拆分）
│   ├── data/                   # 数据管理（导入、编辑、清洗）
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types.ts
│   ├── analysis/               # 统计分析
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types.ts
│   ├── visualization/          # 可视化
│   │   ├── components/
│   │   ├── hooks/
│   │   └── types.ts
│   └── project/                # 项目管理
│       ├── components/
│       ├── hooks/
│       └── types.ts
├── services/                   # Tauri IPC 调用封装
│   ├── dataService.ts
│   ├── statsService.ts
│   ├── ioService.ts
│   └── projectService.ts
├── stores/                     # 全局状态管理 (Zustand)
│   ├── useDataStore.ts
│   ├── useAnalysisStore.ts
│   └── useProjectStore.ts
├── hooks/                      # 通用 hooks
├── types/                      # TypeScript 类型定义
│   ├── data.ts
│   ├── stats.ts
│   └── ipc.ts
└── utils/                      # 工具函数
```

### 7.2 状态管理

使用 **Zustand** 进行全局状态管理，保持轻量：

```typescript
// stores/useDataStore.ts
interface DataStore {
  // 当前活动的数据集 ID
  activeDatasetId: string | null;
  // 数据集元数据列表（从后端同步）
  datasets: DatasetMeta[];
  // 当前视图的分页数据（仅保存当前页）
  currentPage: Row[];
  // 操作
  setActiveDataset: (id: string) => void;
  refreshDatasets: () => Promise<void>;
  fetchPage: (page: number, pageSize: number) => Promise<void>;
}
```

### 7.3 IPC 服务封装

对 Tauri `invoke` 进行类型安全封装：

```typescript
// services/dataService.ts
import { invoke } from '@tauri-apps/api/core';

export const dataService = {
  queryTable: (params: TableQueryParams) =>
    invoke<TableQueryResult>('query_table', params),

  importFile: (filePath: string, options: ImportOptions) =>
    invoke<DatasetMeta>('import_file', { filePath, options }),

  getColumnStats: (datasetId: string, columnName: string) =>
    invoke<ColumnStats>('get_column_stats', { datasetId, columnName }),
};
```

### 7.4 UI 布局设计

```
┌──────────────────────────────────────────────────────────┐
│  菜单栏  [文件] [编辑] [分析] [图表] [工具] [帮助]          │
├────────────┬─────────────────────────────┬───────────────┤
│            │                             │               │
│  数据源     │       主工作区               │   属性面板     │
│  面板       │                             │               │
│            │  ┌─────────────────────────┐ │  - 列属性     │
│  - 数据集   │  │                         │ │  - 数据类型    │
│    列表     │  │    数据表格 / 图表        │ │  - 统计摘要    │
│            │  │    (Tab 切换)            │ │  - 变量角色    │
│  - 变量     │  │                         │ │               │
│    列表     │  │                         │ │               │
│            │  └─────────────────────────┘ │               │
│            │                             │               │
│            │  ┌─────────────────────────┐ │               │
│            │  │  分析结果输出面板          │ │               │
│            │  │  (可折叠)                │ │               │
│            │  └─────────────────────────┘ │               │
├────────────┴─────────────────────────────┴───────────────┤
│  状态栏  [行数: 50,000] [列数: 25] [内存: 12 MB]          │
└──────────────────────────────────────────────────────────┘
```

---

## 8. 前后端通信协议

### 8.1 通信方式

| 方式 | 方向 | 用途 |
|------|------|------|
| `invoke` (Tauri Command) | 前端 → 后端 | 请求-响应式调用 |
| `emit` / `listen` (Tauri Event) | 后端 → 前端 | 异步通知（进度、状态变更） |

### 8.2 数据传输格式

所有 IPC 通信统一使用 JSON 序列化，遵循以下规范：

**请求格式**（invoke 参数）：
```typescript
// 示例：查询数据表
{
  tableName: "dataset_abc123",
  page: 0,
  pageSize: 100,
  sortBy: "column_a",
  sortOrder: "asc",
  filters: [
    { column: "age", op: "gt", value: 18 }
  ]
}
```

**响应格式**：
```typescript
// 成功响应
{
  columns: ["id", "name", "age", "score"],
  columnTypes: ["INTEGER", "VARCHAR", "INTEGER", "DOUBLE"],
  rows: [[1, "Alice", 25, 92.5], ...],
  totalRows: 50000,
  page: 0,
  pageSize: 100
}

// 错误响应 — 由 Tauri 自动包装为 Error
```

### 8.3 大型操作进度通知

```typescript
// 前端监听进度事件
import { listen } from '@tauri-apps/api/event';

await listen<ProgressPayload>('import-progress', (event) => {
  // { taskId: "xxx", progress: 0.75, message: "Reading row 75000/100000" }
  updateProgressBar(event.payload);
});
```

---

## 9. 核心功能模块

### 9.1 数据管理 (DataTable)

| 功能 | 描述 |
|------|------|
| 数据导入 | 支持 CSV, TSV, Excel (.xlsx/.xls), Parquet, JSON |
| 数据导出 | 支持 CSV, Excel, Parquet |
| 数据表格视图 | 虚拟滚动、排序、筛选、列固定 |
| 列属性编辑 | 数据类型转换、变量角色设定 (连续/名义/有序) |
| 缺失值处理 | 标记、填充、删除 |
| 数据筛选 | 行筛选器、列选择器 |
| 新建计算列 | 基于表达式创建派生列 |
| 数据合并 | 支持 JOIN / UNION 操作 |

### 9.2 描述性统计 (Stats.Descriptive)

| 功能 | 描述 |
|------|------|
| 汇总统计 | 均值、中位数、标准差、分位数、偏度、峰度 |
| 频率分布 | 频率表、百分比、累积分布 |
| 相关矩阵 | Pearson / Spearman 相关系数矩阵 |
| 数据分布 | 直方图、箱线图、QQ图 |

### 9.3 统计分析 (Stats.Inference)

| 功能 | 描述 |
|------|------|
| 假设检验 | t 检验（单样本 / 双样本 / 配对）、卡方检验、F 检验 |
| 回归分析 | 线性回归、多元回归、Logistic 回归 |
| 方差分析 | 单因素 ANOVA、多因素 ANOVA |
| 非参数检验 | Mann-Whitney U、Wilcoxon、Kruskal-Wallis |

### 9.4 数据可视化 (Visualization)

| 图表类型 | 说明 |
|----------|------|
| 散点图 | 支持分组着色、回归线叠加 |
| 直方图 | 支持分箱控制、密度曲线 |
| 箱线图 | 支持分组、异常值标记 |
| 折线图 | 时间序列、趋势分析 |
| 柱状图 / 条形图 | 分类数据汇总 |
| 热力图 | 相关矩阵、交叉表 |
| QQ 图 | 正态性检验 |
| 马赛克图 | 分类变量关系 |
| 交互能力 | 缩放、平移、工具提示、联动刷选 |

### 9.5 项目管理 (Project)

| 功能 | 描述 |
|------|------|
| 项目文件 (.spg) | 保存数据集引用、分析配置、图表布局为单一项目文件 |
| 撤销/重做 | 操作历史记录 |
| 最近文件 | 最近打开的项目和数据文件列表 |

---

## 10. 项目目录结构

```
StatsPlayground/
├── docs/                           # 文档
│   ├── spec.md                     # 本文件 — 架构规范
│   └── development.md              # 开发环境配置
├── src/                            # 前端源码
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   ├── features/
│   │   ├── data/
│   │   ├── analysis/
│   │   ├── visualization/
│   │   └── project/
│   ├── services/                   # IPC 调用封装
│   ├── stores/                     # Zustand 状态管理
│   ├── hooks/
│   ├── types/
│   └── utils/
├── src-tauri/                      # Rust 后端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/               # Tauri v2 权限配置
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── commands/
│       ├── services/
│       ├── engine/
│       ├── models/
│       ├── plugins/
│       ├── error.rs
│       └── state.rs
├── public/                         # 静态资源
├── tests/                          # 端到端测试
├── package.json
├── vite.config.ts
├── tsconfig.json
├── LICENSE
└── README.md
```

---

## 11. 开发规范

### 11.1 Rust 规范

- **Rust Edition**: 2021
- **格式化**: `rustfmt`（使用默认配置）
- **Lint**: `clippy`（CI 中开启 `-D warnings`）
- **错误处理**: 使用 `thiserror` 定义错误类型，禁止 `unwrap()` 出现在非测试代码中
- **异步运行时**: 使用 Tauri 内置的 Tokio runtime
- **命名**: 遵循 Rust API Guidelines
  - 类型用 PascalCase
  - 函数与变量用 snake_case
  - 常量用 SCREAMING_SNAKE_CASE
- **测试**: 每个 service 和 engine 模块要有单元测试 (`#[cfg(test)]`)

### 11.2 TypeScript / React 规范

- **语言**: TypeScript strict mode
- **格式化**: Prettier（通过 `.prettierrc` 统一配置）
- **Lint**: ESLint + `@typescript-eslint` 推荐规则
- **组件**: 使用函数组件 + Hooks
- **状态管理**: Zustand（避免 prop drilling 超过 2 层）
- **命名**:
  - 组件文件: PascalCase (`DataTable.tsx`)
  - 工具/服务: camelCase (`dataService.ts`)
  - 类型文件: camelCase (`types.ts`)
  - 常量: SCREAMING_SNAKE_CASE
- **导入顺序**: React → 第三方 → 内部模块 → 同级文件 → 样式

### 11.3 Git 规范

- **分支模型**: GitHub Flow
  - `main` — 稳定版本
  - `feat/*` — 功能分支
  - `fix/*` — 修复分支
  - `docs/*` — 文档更新
- **Commit 格式**: [Conventional Commits](https://www.conventionalcommits.org/)
  ```
  feat(data): add CSV import with encoding detection
  fix(stats): correct standard deviation calculation for sample data
  docs(spec): update architecture diagram
  ```
- **PR 要求**: 至少通过 CI（lint + test + build），描述中说明改动原因

### 11.4 安全规范

- 所有 SQL 操作必须使用参数化查询（prepared statements）
- 文件路径操作需验证在允许的目录范围内（防止路径遍历）
- Tauri `capabilities` 最小权限原则：仅声明实际需要的 API 权限
- 禁止在前端暴露文件系统的绝对路径
- 用户输入在传入 DuckDB 前必须经过类型校验

---

## 12. 构建与发布

### 12.1 开发模式

```bash
# 启动前端 dev server + Tauri 窗口
cargo tauri dev
```

### 12.2 生产构建

```bash
# 构建可分发的安装包
cargo tauri build
```

输出产物：

| 平台 | 格式 |
|------|------|
| Windows | `.msi` / `.exe` (NSIS) |
| macOS | `.dmg` / `.app` |
| Linux (Debian) | `.deb` / `.AppImage` |

### 12.3 CI/CD

使用 GitHub Actions 在三个平台并行构建：

```yaml
# .github/workflows/build.yml
strategy:
  matrix:
    platform: [windows-latest, macos-latest, ubuntu-latest]
```

---

## 13. 路线图

### Phase 1 — 基础框架 (MVP)

- [ ] 项目脚手架搭建 (Tauri + Vite + React)
- [ ] DuckDB 集成与连接管理
- [ ] CSV/Excel 数据导入
- [ ] 数据表格展示 (虚拟滚动 + 分页)
- [ ] 基础描述性统计 (均值、中位数、标准差等)
- [ ] 基础图表 (直方图、散点图、箱线图)

### Phase 2 — 核心分析能力

- [ ] 列属性编辑与变量角色设定
- [ ] 假设检验 (t 检验、卡方检验)
- [ ] 回归分析 (线性回归、多元回归)
- [ ] 方差分析 (ANOVA)
- [ ] 相关矩阵与热力图
- [ ] 数据筛选与清洗工具
- [ ] 项目文件保存/加载

### Phase 3 — 高级功能

- [ ] 试验设计 (DOE)
- [ ] 预测建模 (决策树、随机森林)
- [ ] Logistic 回归
- [ ] 非参数检验
- [ ] 插件系统
- [ ] 数据合并 (JOIN/UNION)
- [ ] 自定义脚本支持

### Phase 4 — 打磨与生态

- [ ] 主题系统 (明/暗模式)
- [ ] 多语言国际化 (中/英)
- [ ] 性能优化 (大数据量场景)
- [ ] 社区插件市场
- [ ] 用户文档网站
