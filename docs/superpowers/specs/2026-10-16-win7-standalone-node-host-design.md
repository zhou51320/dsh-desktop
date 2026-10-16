# Windows 7 独立 Node Host 运行链改造

## 目标

为新版 DSH Desktop 提供可在 Windows 7 SP1 x64 上运行、且能够正常发现、安装与加载插件的便携 ZIP。保留包内独立 Win7 Node 22 与 PythonWin7；Electron 仅承担桌面 UI 壳，不承担 DSH Host、插件加载器、pnpm 或 CLI 的 JavaScript 运行时。

旧版回滚基线保持为 `v2.0.13`（`a7825021a227bc5776525996fc5a794b23d707ac`）。本次改造只触及新版 Desktop 所有者目录和 Windows 7 打包工作流，不编辑 `deepseek-harness/` 子模块。

## 已确认的问题

当前 Win7 包使用 Electron 40 壳，同时仍通过 `utilityProcess.fork()` 和 `ELECTRON_RUN_AS_NODE` 运行 Desktop Host、pnpm 及 CLI。由此使插件加载链进入 Electron Node ABI；`node-addon-require-builtin` 已在该 ABI 下失败。此前 CI 跳过了 Loader smoke，导致“能出包”被误认为“插件能加载”。

参考实现将 Host 和插件链切至包内独立 Node 22，通过 stdio JSON IPC 与 Electron 主进程通信；pnpm 生命周期改用 `npm_config_runtime=node`、Node headers 和实际 Node 版本。这是本次采用的模型。

## 架构

```text
Electron Win7 shell
  ├─ BrowserWindow / renderer
  └─ spawn(resources/runtime/.../node.exe, host-process-entry.js)
       ├─ stdio JSON RPC ←→ Electron main
       ├─ DSH Host / Cordis plugin loader
       ├─ pnpm lifecycle scripts
       └─ dsh CLI / plugin commands

PythonWin7 remains a packaged tool dependency.
```

Electron 与 Host 的控制面改为一行一条 JSON 的 stdin/stdout 协议：stdout 专用于 RPC，Host 日志重定向 stderr。启动、停止、证书与运行时桥接仍沿用现有 `HostRpc` 消息契约，因此不改变渲染器或上游 DSH 的接口。

## 实施范围

1. 在 `desktop-runtime-environment.ts` 增加包内 Node 路径与版本解析，生成的 Node、pnpm、DSH shim 使用实际 Node、`npm_config_runtime=node` 和 Node headers，不再设置 `ELECTRON_RUN_AS_NODE`。
2. 将 `host-process.ts` 由 `utilityProcess.fork()` 改为 `child_process.spawn()` 包内 Node，并实现 stdio `HostPort`。
3. 让 `host-process-entry.ts` 支持 stdio RPC，并把 Host 日志从 stdout 转到 stderr。
4. 将 `main.ts`、profile materializer、terminal、Office 与恢复卸载等所有插件相关运行时入口统一为包内 Node 及实际 Node 版本；保留非 Win7 正常发行的兼容行为。
5. 将 Windows 7 壳固定为参考实现已验证的兼容 Electron 系列，而不是 Electron 40 fork；不使用 Electron 内置 Node 执行 DSH。
6. 恢复并强化打包门禁：包内 Node 启动真实 Host、加载真实插件/Loader、验证 pnpm/CLI。任一 Loader ABI 错误均失败，不能条件跳过。
7. 同步改动至 `dsh-plugin-desktop-beta/`，并运行 Desktop variants 校验。

## 非目标

- 不修改上游 `deepseek-harness`。
- 不承诺 Win7 不支持的 ConPTY、现代 ripgrep、语音/ONNX 或其他依赖 Win8+/Win10 API 的可选功能；这些继续显式降级或禁用。
- 不移除旧版 `v2.0.13` 基线，也不覆盖当前主工作区中用户已有的子模块状态。

## 错误处理与可观测性

- 缺失或无法启动包内 Node 时，Electron 主进程捕获 spawn error，并将 Node 路径和 stderr 尾部写入 Desktop 日志。
- Host stdout 出现非 JSON 行时记录并跳过，避免破坏 RPC；应用日志一律写 stderr。
- Host 退出码、信号及 stderr 尾部会传入现有失败恢复链。
- CI 保存运行时 provenance、native audit、Loader smoke 输出和 SHA256 清单。

## 验收

1. `check:desktop-variants` 通过，Stable 与 Beta 都含等价的运行链。
2. Windows CI 包内 Node 报告为指定 Win7 Node 22，`process.versions.electron` 为空。
3. Host 通过 stdio 成功完成 boot；插件 Loader smoke 不可跳过，加载至少一个真实插件。
4. pnpm 安装/加载链使用 `npm_config_runtime=node`、正确 Node headers 与 Node ABI。
5. 便携 ZIP 在 Win7 SP1 测试机中：插件不再整体显示红色，可加载；PowerShell 5.1 与已安装 Office 2010 COM 功能可用。
6. Action 成功后下载 artifact，核对 ZIP、运行时报告、smoke 输出和 SHA256。

## 回滚

实施前状态标记为 `pre-win7-host-runtime-port-20261016`，指向 `dfafdb27616ae6e749e3dc39c69e8091b3a1456b`。旧版回滚基线仍是 `v2.0.13`。
