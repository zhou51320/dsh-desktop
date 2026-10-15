# Windows 7 x64 Build & Compatibility Guide

本文档参考 [Cherry Studio Windows 7 兼容改造方案](/home/zwh/tools/cherry-studio/WINDOWS7_BUILD.md)，详细说明 DSH Desktop 面向 Windows 7 x64 系统的兼容改造方案、本地与 CI 打包流程、Native PE 审计工具链以及各模块的回退行为矩阵。

---

## 1. 目标系统与支持矩阵

| 操作系统 | 架构 | 最低补丁要求 | 状态 | 运行时 |
| :--- | :--- | :--- | :--- | :--- |
| **Windows 7 SP1** | x64 | KB3063858 (KB2533623), SHA-2 代码签名补丁 (KB4474419) | ⚠️ Electron/Node 支持；Python/原生依赖需逐项验证 | `Electron-for-windows-7` v40.2.0 |
| **Windows 8 / 8.1** | x64 | 默认系统更新 | ✅ 完全支持 | `Electron-for-windows-7` v40.2.0 |
| **Windows Server 2008 R2 SP1** | x64 | KB3063858, KB4474419 | ✅ 完全支持 | `Electron-for-windows-7` v40.2.0 |
| **Windows 10 / 11** | x64 / arm64 | 标准 Windows 10+ | ✅ 官方标准通道 | 官方主线 Electron 34+ |

> [!NOTE]
> Windows 7 专用构建使用独立的流水线（输出到 `dist/win7`），不影响 macOS、Linux 及 Windows 10/11 的官方正式签名发行链路。

---

## 2. 核心架构与运行时基座

### 2.1 Electron 运行时

采用社区成熟维护的 Windows 7 移植版运行时：
- **版本:** `v40.2.0` (Chromium 134 + Node 22.x)
- **发行源:** [Electron-for-windows-7 (v40.2.0)](https://github.com/e3kskoy7wqk/Electron-for-windows-7/releases/download/v40.2.0/dist.zip)
- **SHA-256:** `ed4ebb022624ae38f764fcfc1dc1ce30fe2145298975d4c90e8d95412deeadea`
- **PE 头部特征:** Major/Minor Operating System Version 与 Subsystem Version 均已降至 `5.2` (Windows Server 2003 / XP x64 等级)，移除了 `api-ms-win-core-winrt-*` 等 Win8+ API Set。

### 2.2 本地 SQLite 存储优势

Cherry Studio 使用 `@libsql/win32-x64-msvc` 作为本地 SQLite 驱动，需要专门修补其 PE 导入符号以避免在 Win7 崩溃。

而在 **DSH Desktop** 中，存储模块 [`@deepseek-ai/dsh-storage-sqlite`](file:///home/zwh/aiapp/dsh-desktop/dsh-packages/storage-sqlite) 直接基于 Node.js 原生内置的 [`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`) 实现。`Electron-for-windows-7 v40.2.0` 内置 Node 22.x，已原生提供完整的 `node:sqlite` 支持，因此 **无需针对 SQLite 引入第三方补丁或二次编译二进制**，具备极高的稳定性和零维护成本。

### 2.3 Python 兼容性边界

Win7 包不再携带独立 Node；Office/CLI 的 JavaScript 入口通过 Electron 的 `ELECTRON_RUN_AS_NODE=1` 执行。Python 仍是独立解释器，不能因为 Electron 内置 Node 可用就推断 Python 也可用。

- 官方 CPython 文档明确：Python 3.8 在 Win7 上运行需要 SP1 和 KB2533623；3.8 是最后一个官方支持 Win7 的主线版本。
- 当前上游锁定 Python 3.12.14，且 SDK 声明 `requires-python >=3.10`。直接降级到 3.8 会破坏 SDK 和部分 Office 依赖。
- `python-build-standalone` 的常规 Windows 构建没有给出受官方支持的 Python 3.10–3.12 Win7 发行承诺；未经真实 Win7 VM 验证的“兼容补丁”不能进入发布白名单。

因此当前策略是：Win7 Electron/Node 路径可以进入专项测试；Python/NumPy/pandas/lxml 等必须在 Win7 VM 或 Windows CI 上运行真实 smoke 后才能标记 compatible。若没有经过验证的高版本 Python 构建，Office 能力应报告为 unavailable/experimental，而不是宣称完整支持。

---

## 3. Native 模块审计与回退矩阵

Windows 7 下不支持 ConPTY、现代 Rust 时钟 API 以及 Win11 Mica/Acrylic 特效。DSH Desktop 的具体策略如下：

| 模块 / 二进制 | 风险符号 / 特性 | Windows 7 决策 | 行为与回退保障 |
| :--- | :--- | :--- | :--- |
| **`node-pty`** (`conpty.node`, `conpty.dll`) | `CreatePseudoConsole` (Win10 1809+) | `disabled-on-win7` | 终端执行子进程使用标准流重定向或基于 CMD/PowerShell 管道模式降级。 |
| **`@vscode/ripgrep`** (`rg.exe`) | `GetSystemTimePreciseAsFileTime` (Win8+) | `disabled-on-win7` | 文件内容搜索降级使用基于 Node.js 文件系统的检索逻辑。 |
| **`koffi`** (`koffi.node`) | Win32 基础 API | `compatible` | Koffi 3.1.5 调用的均属于 Win2000+ 原生 API (`GetDriveTypeW`, `CreateJobObjectW`, `AllocConsole` 等)，Win7 完全兼容。 |
| **`fs-ext`** | 文件锁 | `not-required` | 在 Windows 环境下系统使用命名信号量互斥，无需编译 POSIX `fs-ext.node`。 |
| **窗口外观 (Mica / Acrylic)** | DWM Backdrop API | `graceful-fallback` | 客户端窗口已通过系统 build number `>= 22621` 做前置守卫，Win7 自动回退为标准 Classic Aero 窗体，无异常渲染。 |

---

## 4. PE 静态解析与审计工具链

本项目内置纯 TypeScript 实现的 PE 二进制分析与 Win7 审计门禁（零第三方 C++ 依赖）：
- [pe-parser.ts](file:///home/zwh/aiapp/dsh-desktop/dsh-plugin-desktop/scripts/pe-parser.ts):
  - 解析 PE 头部、Section 表、Data Directories 和 RVA 导入表。
  - 自动校验主程序 PE OS/Subsystem 是否降级为 `5.2`。
  - 检测 `CreatePseudoConsole`、`GetSystemTimePreciseAsFileTime`、`CreateFile2`、`WaitOnAddress`、`api-ms-win-core-winrt-*` 等高危符号。
  - 遍历解包目录生成 `native-audit.json` 与 `native-audit.md` 审计报告。
- [report-win7-runtime.ts](file:///home/zwh/aiapp/dsh-desktop/dsh-plugin-desktop/scripts/report-win7-runtime.ts):
  - 针对整个运行时目录的二进制生成 SHA-256 校验与 PE 完整性溯源报告。

---

## 5. 打包命令与使用指南

### 5.1 根目录快捷命令

```bash
# 构建正式版 Windows 7 安装包 (NSIS Setup.exe)
yarn dist:win7

# 构建正式版 Windows 7 便携版 (Portable .zip)
yarn dist:win7-portable

# 构建 Beta 版 Windows 7 安装包
yarn dist:win7:beta

# 构建 Beta 版 Windows 7 便携版
yarn dist:win7-portable:beta
```

### 5.2 子项目命令 (dsh-plugin-desktop)

```bash
# 打包 Win7 安装程序并触发 PE 审计
yarn workspace dsh-plugin-desktop dist:win7

# 打包 Win7 便携 ZIP
yarn workspace dsh-plugin-desktop dist:win7-portable

# 生成运行时溯源报告
yarn workspace dsh-plugin-desktop report:win7-runtime dist/win7/win-unpacked
```

### 5.3 环境变量说明

| 环境变量 | 默认值 | 作用 |
| :--- | :--- | :--- |
| `DSH_WIN7_ELECTRON_DIST` | 无 (空) | 本地解压后的 Win7 Electron 运行时绝对路径。设置后打包脚本会直接注入 `--config.electronDist` 并校验主程序 `5.2` PE 头部。 |
| `DSH_WIN7_ELECTRON_VERSION` | `40.2.0` | 锁定打包使用的 Electron 版本。 |
| `DSH_WIN7_OUTPUT_DIR` | `dist/win7` | Win7 产物的输出目录。 |
| `DSH_WIN7_STRICT_NATIVE` | `0` | 若设为 `1`，当解包产物中存在未经白名单审批的高危符号时，直接阻断构建。 |
| `DSH_WIN7_PYTHONWIN7_DIR` | 无 | 指向固定检出的 [PythonWin7](https://github.com/yuunnn-w/PythonWin7)；Windows 构建准备 Python 后调用其 `tools/build_pack.py`，将 Python 3.12 等高版本改造成裸 Win7 可运行树。 |
| `DSH_WIN7_PYTHONWIN7_PYTHON` | `py` | 执行 PythonWin7 工具的另一套宿主 Python；必须与被改造的目标 Python 不同。 |

---

## 6. GitHub Actions CI 自动化流程

工作流文件位于 [`.github/workflows/win7-desktop-prebuilt.yml`](file:///home/zwh/aiapp/dsh-desktop/.github/workflows/win7-desktop-prebuilt.yml)：
1. 自动检出仓库并启用 Corepack Yarn 依赖缓存。
2. 下载 Windows 7 专用版 Electron 40.2.0 运行时，校验固定 SHA-256 哈希后解压。
3. 矩阵并行构建 `dsh-plugin-desktop`（正式版）与 `dsh-plugin-desktop-beta`（测试版）。
4. 分别执行 `dist:win7` (NSIS) 与 `dist:win7-portable` (ZIP)，并自动产出 `native-audit` 报告与 `SHA256SUMS.txt`。
5. 上传构建归档产物供测试验证。

---

## 7. 自动化测试验证

运行 Windows 兼容性相关的所有单元测试：

```bash
corepack yarn workspace dsh-plugin-desktop test \
  tests/package-win.spec.ts \
  tests/package-win7.spec.ts \
  tests/verify-win-installer.spec.ts \
  tests/verify-win-portable.spec.ts \
  tests/pe-parser.spec.ts
```

在具备完整 Yarn 依赖后运行上述测试；当前 Linux 环境仅完成脚本静态检查，实际 Windows 7 启动与基础对话仍需在 Windows 7 x64 虚拟机中验证。

PythonWin7 是外部构建前处理器，不作为 DSH 源码或运行时资产直接 vendoring。其 GPL-3.0 自研代码、VxKex 二进制、微软 UCRT/MSVC 文件分别遵循各自许可；发布前必须固定 commit、记录 SHA-256，并在 Windows CI 上执行 `build_pack.py --dry-run`、正式改造和 PythonWin7 自带 G0–G5/I1–I7 验收。
