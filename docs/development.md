# 开发环境配置指南

本项目使用 **Tauri v2 + DuckDB + Vite + React/Svelte** 技术栈，以下是各平台的开发环境配置说明。

---

## 目录

- [通用要求](#通用要求)
- [Windows](#windows)
- [macOS](#macos)
- [Debian / Ubuntu](#debian--ubuntu)
- [安装 Tauri CLI](#安装-tauri-cli)
- [Official website](#official-website)
- [Portable build](#portable-build)
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

## Official website

官方站点位于 `website/`，是独立于桌面应用的 Astro 静态站点包。它拥有自己的依赖和构建输出，不会改变根目录 Vite/Tauri 应用的命令或构建语义。

在仓库根目录运行：

```bash
npm --prefix website install
npm --prefix website run dev
npm --prefix website run check
npm --prefix website run build
npm --prefix website run test
```

生产文件生成在 `website/dist/`。推送到 `dev` 且变更 `website/**` 或 `.github/workflows/website.yml` 时，GitHub Pages workflow 会通过 `.github/workflows/website.yml` 构建并部署站点。

当前产品画面使用占位资源，因此 `website/public/images/PLACEHOLDER_MEDIA.md` 会主动阻止 Pages 部署。准备发布时，先用经过隐私检查的真实产品截图替换同目录下的 `statsplayground-workspace.webp` 和 `statsplayground-analysis.webp`，运行 `npm --prefix website run test` 并检查桌面及移动版页面，最后删除 marker 文件。不要在占位资源仍存在时绕过此检查。

首次启用部署时，仓库所有者需要完成以下一次性配置：

1. 在 **Settings → Pages → Build and deployment** 中，将 **Source** 设为 **GitHub Actions**。
2. 按 [GitHub Pages 自定义域名文档](https://docs.github.com/pages/configuring-a-custom-domain-for-your-github-pages-site) 在 DNS 服务商处配置并验证根域名 `statsplayground.org`，等待 DNS 生效后确认记录指向 GitHub Pages。
3. 在 **Settings → Pages → Custom domain** 中填写 `statsplayground.org`，确认域名验证成功；HTTPS 可用后启用 **Enforce HTTPS**。

仓库中的 `website/public/CNAME` 会将 `statsplayground.org` 写入每次静态构建。DNS 和仓库 Pages 设置属于外部部署配置，不由 workflow 自动修改。

---

## Portable build

便携构建使用仓库内置脚本，输出目录固定为 `release/portable/`。

```bash
npm install
npm run build:portable
```

构建完成后，`release/portable/` 中应只包含一个与当前宿主平台匹配的产物：

- Windows：生成 `StatsPlayground-<version>-windows-<arch>.zip`，解压后直接得到 `StatsPlayground.exe`。该构建是宿主机原生构建，运行时仍依赖系统已安装的 WebView2。
- macOS：生成 `StatsPlayground-<version>-macos-<arch>.zip`，解压后直接得到未签名的 `StatsPlayground.app`。

当前便携构建流程不包含代码签名、notarization 或跨平台交叉编译。也就是说，Windows 构建需要在 Windows 主机上完成，macOS 构建需要在 macOS 主机上完成。

### GitHub Release

推送 `v` 开头的语义化版本 tag 后，`.github/workflows/release.yml` 会在 Windows 和 macOS runner 上并行执行便携构建，并把两个平台的产物发布到同一个 GitHub Release。workflow 会从 tag 提取版本号并在 runner 内临时同步 npm、Cargo 和 Tauri manifest，因此发布产物名称与 tag 一致。

用户应从 **Releases → Assets** 下载版本化的平台 ZIP；每个 ZIP 只需解压一次，内部应用名称固定，便于直接替换旧版本。Actions run 页面底部的 `ci-transfer-*` Artifacts 仅用于 job 之间传输，GitHub 会为其额外添加一层 ZIP，不作为用户下载入口。

对于早于 workflow 创建的既有 tag，在 GitHub Actions 中手动运行 **Release Portable**，并将 `tag` 输入设为完整 tag（例如 `v0.0.0-alpha.1`）。workflow 会使用当前分支的发布脚本构建该 tag 的应用源码，因此旧 tag 本身不需要包含这些脚本。包含连字符的版本会发布为 prerelease。

发布权限只授予最终的 `release` job；两个构建 job 保持 `contents: read`。当前流程不执行 Windows 代码签名或 macOS signing/notarization。

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
