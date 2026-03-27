# 项目脚手架说明

本文档记录 StatsPlayground 当前脚手架的完整结构、技术依赖和各文件职责。

---

## 目录结构

```
StatsPlayground/
├── docs/                               # 项目文档
│   ├── development.md                  #   开发环境配置指南
│   ├── scaffold.md                     #   脚手架说明（本文件）
│   └── spec.md                         #   系统架构与开发规范
│
├── src/                                # 前端源码 (React + TypeScript)
│   ├── main.tsx                        #   React 入口，挂载 <App /> 到 DOM
│   ├── App.tsx                         #   根组件，三栏布局骨架（菜单栏 / 数据源面板 / 主区域 / 状态栏）
│   ├── App.css                         #   根组件样式
│   ├── index.css                       #   全局基础样式
│   ├── vite-env.d.ts                   #   Vite 类型声明引用
│   ├── services/                       #   Tauri IPC 调用封装层
│   │   ├── index.ts                    #     统一导出
│   │   ├── dataService.ts              #     数据操作 (import, query, list, delete)
│   │   ├── statsService.ts             #     统计分析 (column stats, descriptive)
│   │   └── ioService.ts                #     文件导出 (export CSV)
│   ├── stores/                         #   Zustand 全局状态管理
│   │   ├── index.ts                    #     统一导出
│   │   └── useDataStore.ts             #     数据集状态 (activeDatasetId, datasets, refreshDatasets)
│   └── types/                          #   TypeScript 类型定义
│       ├── index.ts                    #     统一导出
│       ├── data.ts                     #     数据模型 (DatasetMeta, ColumnMeta, TableQueryParams, TableQueryResult)
│       └── stats.ts                    #     统计模型 (ColumnStats, DescriptiveResult)
│
├── src-tauri/                          # Rust 后端 (Tauri v2)
│   ├── Cargo.toml                      #   Rust 依赖配置
│   ├── Cargo.lock                      #   依赖锁定文件
│   ├── build.rs                        #   Tauri 构建脚本
│   ├── tauri.conf.json                 #   Tauri 应用配置 (窗口、构建命令、图标)
│   ├── capabilities/                   #   Tauri v2 权限声明
│   │   └── default.json                #     默认权限 (core, dialog, fs)
│   ├── icons/                          #   应用图标 (自动生成)
│   ├── gen/                            #   Tauri 自动生成的 schema 文件
│   └── src/                            #   Rust 源码
│       ├── main.rs                     #     入口，调用 lib::run()
│       ├── lib.rs                      #     模块注册 + Tauri Builder + Command 注册
│       ├── state.rs                    #     全局状态 (AppState: Mutex<DuckDbEngine>)
│       ├── error.rs                    #     统一错误类型 (AppError) + From 实现
│       ├── commands/                   #     Tauri Command 层（前端调用入口）
│       │   ├── mod.rs                  #       模块注册
│       │   ├── data_commands.rs        #       import_file, list_datasets, delete_dataset, query_table
│       │   ├── stats_commands.rs       #       get_column_stats, get_descriptive_stats
│       │   └── io_commands.rs          #       export_csv
│       ├── services/                   #     业务逻辑层
│       │   ├── mod.rs                  #       模块注册
│       │   ├── data_service.rs         #       DataService (封装数据操作)
│       │   ├── stats_service.rs        #       StatsService (封装统计计算)
│       │   └── io_service.rs           #       IoService (封装文件导出)
│       ├── engine/                     #     引擎层
│       │   ├── mod.rs                  #       模块注册
│       │   └── duckdb_engine.rs        #       DuckDbEngine (DuckDB 连接、元数据表、CRUD、统计查询、导出)
│       └── models/                     #     数据模型
│           ├── mod.rs                  #       模块注册
│           ├── table.rs                #       DatasetMeta, ColumnMeta, TableQueryResult
│           └── stats.rs                #       ColumnStats, DescriptiveResult
│
├── index.html                          # Vite 入口 HTML
├── package.json                        # npm 依赖与脚本
├── package-lock.json                   # npm 依赖锁定
├── vite.config.ts                      # Vite 构建配置 (端口 1420, alias @/, Tauri HMR)
├── tsconfig.json                       # TypeScript 项目引用 (app + node)
├── tsconfig.app.json                   # 前端 TS 配置 (strict, react-jsx, path alias)
├── tsconfig.node.json                  # 构建工具 TS 配置 (vite.config.ts)
├── app-icon.svg                        # 应用图标源文件
├── .gitignore                          # Git 忽略规则
├── LICENSE                             # MIT 许可证
└── README.md                           # 项目简介
```

---

## 技术依赖

### 前端 (npm)

| 包名 | 版本 | 用途 |
|------|------|------|
| react | ^19.0.0 | UI 框架 |
| react-dom | ^19.0.0 | React DOM 渲染 |
| @tauri-apps/api | ^2.0.0 | Tauri IPC 调用 (invoke / events) |
| @tauri-apps/plugin-dialog | ^2.0.0 | 系统文件对话框 |
| @tauri-apps/plugin-fs | ^2.0.0 | 文件系统访问 |
| zustand | ^5.0.0 | 轻量状态管理 |

| 开发依赖 | 版本 | 用途 |
|----------|------|------|
| vite | ^6.0.0 | 前端构建与 HMR |
| @vitejs/plugin-react | ^4.0.0 | Vite React 插件 |
| typescript | ~5.7.0 | TypeScript 编译器 |
| @tauri-apps/cli | ^2.0.0 | Tauri CLI (npm 方式) |
| @types/react | ^19.0.0 | React 类型定义 |
| @types/react-dom | ^19.0.0 | ReactDOM 类型定义 |
| @types/node | ^25.5.0 | Node.js 类型定义 |

### 后端 (Cargo)

| Crate | 版本 | 用途 |
|-------|------|------|
| tauri | 2 | 桌面应用框架 |
| tauri-build | 2 | Tauri 构建依赖 |
| tauri-plugin-dialog | 2 | 文件对话框插件 |
| tauri-plugin-fs | 2 | 文件系统插件 |
| duckdb | 1 (bundled) | 嵌入式分析数据库 |
| serde | 1 (derive) | 序列化 / 反序列化 |
| serde_json | 1 | JSON 处理 |
| thiserror | 2 | 错误类型派生宏 |
| tokio | 1 (full) | 异步运行时 |
| uuid | 1 (v4) | UUID 生成 |

---

## 架构分层

```
┌──────────────────────────────────────────────────┐
│               前端 (src/)                         │
│  React 19 + TypeScript + Zustand                  │
│  ┌────────────┬─────────────┬──────────────┐     │
│  │ services/  │ stores/     │ types/       │     │
│  │ IPC 调用    │ 状态管理     │ 类型定义      │     │
│  └────────────┴─────────────┴──────────────┘     │
├───────────────── Tauri IPC ──────────────────────┤
│               后端 (src-tauri/src/)               │
│  ┌─────────────────────────────────────────┐     │
│  │ commands/     ← Tauri Command 入口       │     │
│  ├─────────────────────────────────────────┤     │
│  │ services/     ← 业务逻辑封装             │     │
│  ├─────────────────────────────────────────┤     │
│  │ engine/       ← DuckDB 引擎             │     │
│  ├─────────────────────────────────────────┤     │
│  │ models/       ← 数据结构定义             │     │
│  ├─────────────────────────────────────────┤     │
│  │ state.rs      ← 全局状态 (AppState)      │     │
│  │ error.rs      ← 统一错误类型             │     │
│  └─────────────────────────────────────────┘     │
└──────────────────────────────────────────────────┘
```

### 调用链路

```
前端 invoke("import_file", { filePath })
  → commands/data_commands.rs::import_file()
    → services/data_service.rs::DataService::import_csv()
      → engine/duckdb_engine.rs::DuckDbEngine::import_csv()
        → DuckDB: CREATE TABLE ... FROM read_csv(...)
          → 返回 DatasetMeta
```

---

## 已注册的 Tauri Commands

| Command | 文件 | 功能 |
|---------|------|------|
| `import_file` | data_commands.rs | 导入 CSV 文件为数据集 |
| `list_datasets` | data_commands.rs | 列出所有数据集元数据 |
| `delete_dataset` | data_commands.rs | 删除数据集及其元数据 |
| `query_table` | data_commands.rs | 分页查询数据表（支持排序） |
| `get_column_stats` | stats_commands.rs | 单列描述性统计 |
| `get_descriptive_stats` | stats_commands.rs | 全表描述性统计 |
| `export_csv` | io_commands.rs | 导出数据集为 CSV 文件 |

---

## DuckDB 元数据表

应用启动时自动在内存数据库中创建：

| 表名 | 用途 |
|------|------|
| `_meta_datasets` | 记录所有导入数据集的 ID、名称、来源、行列数、时间戳 |
| `_meta_columns` | 记录每个数据集的列信息（名称、类型、角色、缺失值数） |

用户导入的每个数据文件会创建为 `dataset_{uuid}` 表。

---

## 构建与运行命令

| 命令 | 用途 |
|------|------|
| `cargo tauri dev` | 开发模式（前端 HMR + Rust 热重载） |
| `cargo tauri build` | 生产构建（生成安装包） |
| `npm run dev` | 仅启动前端 dev server |
| `npm run build` | 仅构建前端产物 |

---

## 配置要点

### Vite (vite.config.ts)
- 端口：`1420`（strict mode）
- 路径别名：`@/` → `src/`
- 排除 `src-tauri/` 的文件监听
- Tauri 远程开发 HMR 支持

### Tauri (tauri.conf.json)
- 窗口：1280×800，最小 900×600
- 前端开发地址：`http://localhost:1420`
- 前端产物目录：`../dist`
- 应用标识：`com.statsplayground.app`

### Tauri 权限 (capabilities/default.json)
- `core:default` — 基础能力
- `dialog:allow-open`, `dialog:allow-save` — 文件对话框
- `fs:default` — 文件系统访问

### Rust 发布优化 (Cargo.toml)
- LTO 开启、单 codegen unit、size 优化、strip 符号
