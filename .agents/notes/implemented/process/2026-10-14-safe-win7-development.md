# Win7 适配开发的资源安全规则

## 背景

2026-10-14 在本项目执行 Win7 适配时，虚拟机和宿主 PVE 曾出现卡死。现有证据显示：虚拟机只有约 3.5 GiB 内存、根文件系统约 194 GiB 且剩余约 12 GiB（94% 已用）；同时仓库包含约 624 MiB `.git`、约 332 MiB 本地 Win7 Electron runtime。此前执行了大规模 `git pull`（约 3500 个文件）并启动 `corepack yarn install --immutable`。本次安装在 Fetch 阶段长时间运行，且 `.yarnrc.yml` 的 `supportedArchitectures.os` 同时包含 `current` 和 `win32`，会让 Yarn 为跨平台原生依赖准备额外副本，显著放大磁盘、网络和 I/O 压力。

## 必须遵守

1. 在本 VM 上禁止并行执行 `yarn install`、构建、打包或 Electron 启动；一次只运行一个重任务。
2. 重任务前先执行 `free -h` 和 `df -h /`。可用内存低于 2 GiB 或磁盘可用空间低于 20 GiB 时停止，不启动安装/构建；磁盘达到 90% 以上时只做静态检查。
3. 不在 Linux 开发机下载完整 Win32 原生依赖矩阵。Win7 依赖安装和真实打包放到 Windows CI；本地仅使用已有依赖做脚本/单元测试静态验证。除非用户明确批准，不扩大 `.yarnrc.yml` 的跨平台 `supportedArchitectures` 下载范围。
4. 下载或安装必须设置代理，并设置可观察的超时；超过 60 秒无进展先停止检查，不允许后台遗留安装进程。禁止用多个代理端口循环并发重试。
5. Win7 runtime 只保留 CI 下载产物或按需下载到临时目录；不要把 300MB 级 runtime 重复复制到多个目录。完成验证后清理临时压缩包。
6. 修改前先保存工作区（优先 `git stash push -u` 或提交）；不得用 `git pull` 覆盖未提交改动。同步远端只允许在确认磁盘空间并使用 `--ff-only` 后执行。
7. 不运行 `yarn check`、完整 `yarn build` 或 `electron-builder` 作为默认验证。先运行 `git diff --check`、JSON/TypeScript 语法检查和目标小型测试；完整门禁只在资源充足的 CI/专用 Windows runner 执行。

## 本次事故的操作结论

- 主要风险是低内存/低磁盘 VM 上的大规模 Git 更新叠加 Yarn 跨平台依赖 Fetch，导致高 I/O、缓存和进程内存峰值；PVE 卡死是宿主对来宾资源耗尽后的连锁反应，不能归因于单个 TypeScript 脚本。
- 后续 Win7 适配继续采用“代码与审计脚本在本地、依赖安装和实际打包在 Windows CI”的边界。任何需要突破上述资源阈值的操作，先向用户报告并请求确认。

## 本次扩容后的本地验证补充

- 扩容后根盘可用约 210 GiB，内存约 7.8 GiB；依赖安装、构建和测试均在低优先级、单进程、超时保护下完成，未低于 10% 磁盘余量。
- NSIS 默认高压缩 `7za -mx=9` 曾达到约 5.4 GiB RSS，使可用内存降至约 1.8 GiB；必须通过 `DSH_WINDOWS_PACKAGE_COMPRESSION=store` 降低压缩内存峰值，或直接在 Windows CI 打包。
- Linux Wine 对 NSIS 最终验证出现 `free(): invalid pointer`，不能据此判断 Windows 安装包可运行；应在 Windows runner/Windows 7 VM 验证。
- Portable 包的严格 native 审计发现 19 个未批准风险项（包括 bundled Node 24、uv、LibreOffice、sharp、ripgrep、ConPTY、Sherpa ONNX 等）。禁止仅为让构建变绿而加入白名单；每项必须先禁用/延迟加载、替换二进制或提供回退，再重新审计。

## Electron Node 与 Python 的 Win7 边界（2026-10-15）

- Win7 的基础方案是使用专用 Electron 的内置 Node（`ELECTRON_RUN_AS_NODE=1`），不再把独立 Node 24 作为 Win7 primary runtime 的必需文件；Office/CLI 通过可写目录中的 `electron-node.cmd` 包装器调用 Electron。
- Python 与 Node 完全独立。官方 CPython 3.8 是最后支持 Win7 的主线，当前项目锁定 Python 3.12.14 且 SDK 要求 `>=3.10`，不能直接降级到 3.8。
- 未找到可直接信任的、官方维护的 Python 3.10–3.12 Win7 构建；高版本 Python 必须在真实 Win7 VM/Windows CI 通过解释器、NumPy、pandas、lxml、Office smoke 后才能放行。未经验证时将 Python/Office 标为待验证，不加入 native 白名单。

## PythonWin7 参考方案（2026-10-15）

- 已审阅 `yuunnn-w/PythonWin7`，HEAD 为 `ee222fc9fe077c93685a3141436652add742d97d`。其路线覆盖官方 CPython 3.9–3.14：私有 UCRT、核心 DLL IAT 引导修补、PyKexLdr/PyKexBoot 运行时导入改写、wheel 安装门禁和可搬迁 shim。
- DSH 通过可选 `DSH_WIN7_PYTHONWIN7_DIR` 调用其 `tools/build_pack.py`，不复制其 GPL-3.0 源码或 VxKex/微软第三方资产；发布流水线必须固定 commit、校验资产并在 Windows CI/Win7 VM 做完整验收。
- PythonWin7 的高版本兼容是外部方案，不等于已经通过本项目发布门禁；在真实 Win7 smoke 前仍保持 Python/Office “待验证”。
