# 开发环境配置指南

本项目使用 **Tauri v2 + DuckDB + Vite + React/Svelte** 技术栈，以下是各平台的开发环境配置说明。

---

## 目录

- [通用要求](#通用要求)
- [Windows](#windows)
- [macOS](#macos)
- [Debian / Ubuntu](#debian--ubuntu)
- [安装 Tauri CLI](#安装-tauri-cli)
- [DuckDB 集成说明](#duckdb-集成说明)
- [验证环境](#验证环境)
- [推荐的开发工具](#推荐的开发工具)

---

## 通用要求

| 工具 | 最低版本 |
|------|----------|
| Rust (rustc) | ≥ 1.77.2 |
| Node.js | ≥ 20.x LTS |
| npm | ≥ 10.x |
| Tauri CLI | ≥ 2.0 |

---

## Windows

### 1. Microsoft Visual Studio C++ Build Tools

Tauri v2 在 Windows 上需要 MSVC 编译器和 Windows SDK。

1. 下载 [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
2. 安装时勾选 **"Desktop development with C++"** 工作负载
3. 确保以下组件被选中：
   - MSVC v143 (或更新版本) C++ 生成工具
   - Windows 10/11 SDK

### 2. WebView2

- Windows 10 (1803+) 和 Windows 11 通常已预装
- 如未安装，从 [Microsoft 官网](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) 下载 Evergreen Bootstrapper

### 3. Rust 工具链

```powershell
# 通过 winget 安装
winget install Rustlang.Rustup

# 或从 https://rustup.rs 下载 rustup-init.exe 并运行

# 验证
rustc --version
cargo --version
```

### 4. Node.js

```powershell
winget install OpenJS.NodeJS.LTS

# 验证
node --version
npm --version
```

### 5. 可选：安装 pnpm

```powershell
npm install -g pnpm
```

---

## macOS

### 1. Xcode Command Line Tools

Tauri v2 在 macOS 上需要 Clang 编译器和 macOS SDK。

```bash
xcode-select --install
```

> 如果已安装 Xcode，此步骤可跳过。

### 2. Rust 工具链

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装完成后加载环境变量
source "$HOME/.cargo/env"

# 验证
rustc --version
cargo --version
```

### 3. Node.js

推荐使用 [Homebrew](https://brew.sh/) 安装：

```bash
# 如果还没有 Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 安装 Node.js LTS
brew install node@20

# 验证
node --version
npm --version
```

### 4. 可选：安装 pnpm

```bash
npm install -g pnpm
```

---

## Debian / Ubuntu

### 1. 系统依赖

Tauri v2 在 Linux 上需要一系列系统库。运行以下命令一次性安装：

```bash
sudo apt update
sudo apt install -y \
    build-essential \
    curl \
    wget \
    file \
    libssl-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libwebkit2gtk-4.1-dev \
    libjavascriptcoregtk-4.1-dev \
    libsoup-3.0-dev \
    libglib2.0-dev \
    patchelf
```

> **注意**：Tauri v2 使用 `webkit2gtk-4.1` 和 `libsoup-3.0`，与 Tauri v1 的依赖不同。确保安装的是 `-4.1` 版本而非 `-4.0`。

### 2. Rust 工具链

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 安装完成后加载环境变量
source "$HOME/.cargo/env"

# 验证
rustc --version
cargo --version
```

### 3. Node.js

推荐使用 [NodeSource](https://github.com/nodesource/distributions) 安装 LTS 版本：

```bash
# 安装 Node.js 20.x LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node --version
npm --version
```

### 4. 可选：安装 pnpm

```bash
npm install -g pnpm
```

---

## 安装 Tauri CLI

所有平台通用，二选一：

```bash
# 方式一：通过 Cargo 安装（推荐）
cargo install tauri-cli --version "^2"

# 方式二：通过 npm 安装
npm install -g @tauri-apps/cli@latest
```

验证：

```bash
cargo tauri --version   # ≥ 2.0
```

---

## DuckDB 集成说明

根据架构需求，DuckDB 有两种集成方式：

| 方式 | 说明 | 集成方法 |
|------|------|----------|
| **Rust 后端（推荐）** | 在 Tauri 后端通过 Rust crate 调用，性能更好，适合大数据量 | 在 `src-tauri/Cargo.toml` 中添加 `duckdb = "1.x"` 依赖 |
| **WASM 前端** | 在浏览器端通过 WebAssembly 运行 | `npm install @duckdb/duckdb-wasm` |

选择 Rust 后端集成时无需额外安装，Cargo 会在构建时自动下载编译。

---

## 验证环境

全部安装完成后，运行以下命令确认环境就绪：

```bash
rustc --version        # ≥ 1.77.2
cargo --version
node --version         # ≥ 20.x
npm --version          # ≥ 10.x
cargo tauri --version  # ≥ 2.0
```

---

## 推荐的开发工具

| 工具 | 用途 |
|------|------|
| [VS Code](https://code.visualstudio.com/) | 主编辑器 |
| [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) | Rust 语言智能提示与错误检查 |
| [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) | Tauri 项目调试支持 |
| [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) | 前端代码质量检查 |
| [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) | 代码格式化 |
