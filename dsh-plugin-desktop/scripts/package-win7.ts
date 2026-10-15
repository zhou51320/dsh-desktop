/** Build an unsigned Windows 7-compatible x64 artifact on a native Windows host. */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createWindowsPackageOptions,
  windowsCompressionOverride,
  withoutWindowsSigningSecrets,
  type WindowsPackageOptions,
} from './package-win.ts'
import { electronBuilderEnvironment } from './electron-builder-environment.ts'
import {
  auditNativeBinaries,
  isPeFile,
  readPeImports,
  readPeVersions,
  renderNativeAuditMarkdown,
  type Win7NativeDecision,
} from './pe-parser.ts'

export const DEFAULT_WIN7_ELECTRON_VERSION = '40.2.0'
export const DEFAULT_WIN7_OUTPUT_DIR = 'dist/win7'

export const DSH_WIN7_NATIVE_AUDIT_DECISIONS: readonly Win7NativeDecision[] = [
  {
    match: 'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    decision: 'disabled-on-win7',
    note: 'ConPTY requires Windows 10 (1809+); Windows 7 terminal subprocesses use standard streams or winpty fallback.',
  },
  {
    match: 'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
    decision: 'disabled-on-win7',
    note: 'Console list helper for ConPTY is not used on Windows 7.',
  },
  {
    match: 'node_modules/node-pty/prebuilds/win32-x64/conpty/OpenConsole.exe',
    decision: 'disabled-on-win7',
    note: 'OpenConsole helper requires Windows 10; skipped on Windows 7.',
  },
  {
    match: 'node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll',
    decision: 'disabled-on-win7',
    note: 'conpty.dll requires Windows 10 PseudoConsole APIs; skipped on Windows 7.',
  },
  {
    match: 'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe',
    decision: 'disabled-on-win7',
    note: 'Bundled ripgrep executable imports GetSystemTimePreciseAsFileTime; search falls back to Node.js filesystem search.',
  },
  {
    match: 'node_modules/@deepseek-ai/node-addon-system-win32-x64/system.node',
    decision: 'lazy-loaded',
    note: 'System native addon is optional and lazy-loaded.',
  },
]

export interface Windows7PackageOptions extends WindowsPackageOptions {
  /** Path to pre-extracted Windows 7-compatible Electron runtime. */
  readonly electronDist?: string
  /** Pinned Electron version for the Win7 build. */
  readonly electronVersion?: string
  /** Distribution output directory relative to desktopRoot. */
  readonly outputDir?: string
  /** Whether to fail packaging when unapproved risky native imports are found. */
  readonly strictNative?: boolean
  /** Whether to verify Win7 PE header lowering on the main executable. */
  readonly verifyWin7Pe?: boolean
}

/** Create Windows 7 packaging options with environment defaults. */
export function createWindows7PackageOptions(
  verifier = './verify-win-installer.ts',
): Windows7PackageOptions {
  const base = createWindowsPackageOptions(verifier)
  const electronDist = process.env.DSH_WIN7_ELECTRON_DIST !== undefined && process.env.DSH_WIN7_ELECTRON_DIST.length > 0
    ? resolve(process.env.DSH_WIN7_ELECTRON_DIST)
    : undefined
  const electronVersion = process.env.DSH_WIN7_ELECTRON_VERSION ?? DEFAULT_WIN7_ELECTRON_VERSION
  const outputDir = process.env.DSH_WIN7_OUTPUT_DIR ?? DEFAULT_WIN7_OUTPUT_DIR
  const strictNative = process.env.DSH_WIN7_STRICT_NATIVE === '1'

  return {
    ...base,
    ...(electronDist === undefined ? {} : { electronDist }),
    electronVersion,
    outputDir,
    strictNative,
  }
}

/** Verify main application executable for Windows 7 PE compliance. */
export function verifyWin7Executable(executablePath: string): void {
  if (!existsSync(executablePath)) {
    throw new Error(`Win7 verification failed; application executable missing: ${executablePath}`)
  }
  if (!isPeFile(executablePath)) {
    throw new Error(`Win7 verification failed; ${executablePath} is not a valid PE image`)
  }

  const versions = readPeVersions(executablePath)
  if (versions.os !== '5.2' || versions.subsystem !== '5.2') {
    throw new Error(
      `Win7 verification failed; expected PE os=5.2 subsystem=5.2, received os=${versions.os} subsystem=${versions.subsystem}`,
    )
  }

  const imports = readPeImports(executablePath)
  for (const risky of ['GetSystemTimePreciseAsFileTime', 'CreateFile2', 'CreatePseudoConsole']) {
    if (imports.functions.has(risky)) {
      throw new Error(`Win7 verification failed; application imports forbidden function: ${risky}`)
    }
  }
  for (const dll of imports.dlls) {
    if (dll.toLowerCase().startsWith('api-ms-win-core-winrt')) {
      throw new Error(`Win7 verification failed; application imports forbidden WinRT DLL: ${dll}`)
    }
  }
}

function assertWindows7PackageHost(options: WindowsPackageOptions, artifact: string): void {
  if (options.platform !== 'win32' && options.platform !== 'linux') {
    throw new Error(`Windows 7 ${artifact} must be built on Windows or Linux; received ${options.platform}`)
  }
  if (options.arch !== 'x64') {
    throw new Error(`Windows ${artifact} requires x64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Windows ${artifact} requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }
}

function resolveDistDir(desktopRoot: string, outputDir: string): string {
  if (desktopRoot.includes('\\')) {
    const relativePart = outputDir.replace(/^\.[\\/]/u, '')
    return `${desktopRoot}\\${relativePart.replace(/\//gu, '\\')}`
  }
  return resolve(desktopRoot, outputDir)
}

/** Package one unsigned Windows 7-compatible artifact and run native PE audit. */
export function packageWindows7Artifact(
  options: Windows7PackageOptions,
  target: 'nsis' | 'zip',
  artifact: 'installer' | 'portable archive',
): void {
  assertWindows7PackageHost(options, artifact)

  const cleanEnvironment = withoutWindowsSigningSecrets(options.env)
  const compression = windowsCompressionOverride(options.env)
  const electronVersion = options.electronVersion ?? DEFAULT_WIN7_ELECTRON_VERSION
  const outputDir = options.outputDir ?? DEFAULT_WIN7_OUTPUT_DIR
  const resolvedOutputDir = resolveDistDir(options.desktopRoot, outputDir)

  options.log(`Building an unsigned Windows 7 x64 ${artifact} with Electron ${electronVersion}.`)
  if (options.electronDist !== undefined) {
    options.log(`Using custom Win7 Electron distribution at ${options.electronDist}`)
  } else {
    options.log('Notice: DSH_WIN7_ELECTRON_DIST is not set; using configured Electron version.')
  }

  const workspaceName = options.desktopRoot.split(/[\\/]/u).filter(Boolean).pop() ?? 'dsh-plugin-desktop'
  if (options.env.DSH_PACKAGE_CHECK_ALREADY_RAN !== '1') {
    const isWindows = options.platform === 'win32'
    options.run(
      isWindows ? options.commandShell : 'bash',
      isWindows
        ? ['/d', '/s', '/c', `corepack yarn workspace ${workspaceName} check:win-package`]
        : ['-c', `corepack yarn workspace ${workspaceName} check:win-package`],
      options.workspaceRoot,
      cleanEnvironment,
    )
  } else {
    options.log('Skipping the Windows package preflight; the package gate already passed.')
  }

  // Always materialize and validate the packaged runtime tree.  A supplied
  // Win7 Node archive is an input to prepare-runtime; it must not cause the
  // preparation step to be skipped (otherwise runtime.json is missing).
  options.run(
    options.nodeExecutable,
    ['scripts/prepare-runtime.ts'],
    options.desktopRoot,
    {
      ...cleanEnvironment,
      DSH_RUNTIME_PLATFORM: 'win32',
      ...(options.env.DSH_WIN7_NODE_ARCHIVE === undefined ? { DSH_WIN7_ELECTRON_NODE: '1' } : {}),
    },
  )
  options.prepareRuntime(false)

  const builderArgs: string[] = [
    options.builderCli,
    '--win',
    target,
    '--x64',
    '--publish',
    'never',
    '--config.win.signExecutable=false',
    '--config.npmRebuild=false',
    '--config.electronFuses.onlyLoadAppFromAsar=false',
    `--config.directories.output=${outputDir}`,
    `--config.electronVersion=${electronVersion}`,
  ]
  if (options.electronDist !== undefined) {
    builderArgs.push(`--config.electronDist=${options.electronDist}`)
  }
  if (compression !== undefined) {
    builderArgs.push(`--config.win.compression=${compression}`)
  }

  options.run(
    options.nodeExecutable,
    builderArgs,
    options.desktopRoot,
    electronBuilderEnvironment({
      ...cleanEnvironment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      DSH_WIN7: '1',
    }),
  )

  const unpackedAppDir = join(resolvedOutputDir, 'win-unpacked')
  const executableCandidates = [
    join(unpackedAppDir, 'DSH Desktop.exe'),
    join(unpackedAppDir, 'DSH Desktop Beta.exe'),
  ]
  const executablePath = executableCandidates.find(p => existsSync(p)) ?? join(unpackedAppDir, 'DSH Desktop.exe')

  if (options.electronDist !== undefined && options.verifyWin7Pe !== false) {
    verifyWin7Executable(executablePath)
    options.log('Main executable verified for Win7 PE header and symbol compatibility.')
  }

  if (existsSync(unpackedAppDir)) {
    const { entries, failures } = auditNativeBinaries(
      unpackedAppDir,
      DSH_WIN7_NATIVE_AUDIT_DECISIONS,
    )

    mkdirSync(resolvedOutputDir, { recursive: true })
    const jsonReport = join(resolvedOutputDir, 'native-audit.json')
    const mdReport = join(resolvedOutputDir, 'native-audit.md')
    writeFileSync(
      jsonReport,
      `${JSON.stringify({ generatedAt: new Date().toISOString(), entries }, null, 2)}\n`,
    )
    writeFileSync(mdReport, renderNativeAuditMarkdown(entries))
    options.log(`Wrote Windows 7 native audit reports to ${outputDir}`)

    if (failures.length > 0 && options.strictNative !== false) {
      throw new Error(`Windows 7 native audit failed:\n${failures.join('\n')}`)
    }
  }

  options.run(
    options.nodeExecutable,
    [options.verifier],
    options.desktopRoot,
    {
      ...cleanEnvironment,
      DSH_DIST_DIR: resolvedOutputDir,
    },
  )
}

/** Package an unsigned Windows 7 NSIS installer. */
export function packageWindows7Installer(
  options: Windows7PackageOptions = createWindows7PackageOptions(),
): void {
  packageWindows7Artifact(options, 'nsis', 'installer')
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageWindows7Installer()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
