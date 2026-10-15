import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  packageWindows7Artifact,
  packageWindows7Installer,
  verifyWin7Executable,
  type Windows7PackageOptions,
} from '../scripts/package-win7.ts'

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

const temporaryRoots: string[] = []

function createSyntheticPe(options: {
  readonly osMajor?: number
  readonly osMinor?: number
  readonly subMajor?: number
  readonly subMinor?: number
} = {}): Buffer {
  const buf = Buffer.alloc(512)
  buf.write('MZ', 0, 'ascii')
  buf.writeUInt32LE(0x80, 0x3c)
  buf.write('PE\0\0', 0x80, 'binary')
  buf.writeUInt16LE(0x8664, 0x84)
  buf.writeUInt16LE(0, 0x86)
  buf.writeUInt16LE(0x70, 0x94)
  buf.writeUInt16LE(0x20b, 0x98)
  buf.writeUInt16LE(options.osMajor ?? 5, 0xc0)
  buf.writeUInt16LE(options.osMinor ?? 2, 0xc2)
  buf.writeUInt16LE(options.subMajor ?? 5, 0xc8)
  buf.writeUInt16LE(options.subMinor ?? 2, 0xca)
  return buf
}

function options(calls: CommandCall[], logs: string[] = []): Windows7PackageOptions {
  return {
    env: {
      PATH: 'C:\\Windows\\System32',
      SAFE_VALUE: 'kept',
      CSC_LINK: 'private-generic-certificate',
      csc_key_password: 'private-generic-password',
      win_csc_link: 'C:\\private\\publisher.pfx',
      WIN_CSC_KEY_PASSWORD: 'private-windows-password',
    },
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '22.23.2',
    workspaceRoot: 'C:\\repo',
    desktopRoot: 'C:\\repo\\dsh-plugin-desktop',
    commandShell: 'C:\\Windows\\System32\\cmd.exe',
    builderCli: 'C:\\repo\\node_modules\\electron-builder\\cli.js',
    prepareRuntime: () => undefined,
    verifier: 'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-installer.ts',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
    run: (command, args, cwd, env) => {
      calls.push({ command, args: [...args], cwd, env: { ...env } })
    },
    log: message => logs.push(message),
    electronVersion: '40.2.0',
    outputDir: 'dist/win7',
    strictNative: false,
    verifyWin7Pe: false,
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Windows 7 x64 installer packaging', () => {
  it('checks without credentials, builds an unsigned NSIS target for Win7 with Electron 40.2.0, then verifies it', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []
    const prepareRuntime = vi.fn()

    packageWindows7Installer({ ...options(calls, logs), prepareRuntime })

    expect(prepareRuntime).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(4)
    expect(calls[0]).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        'corepack yarn workspace dsh-plugin-desktop check:win-package',
      ],
      cwd: 'C:\\repo',
      env: { PATH: 'C:\\Windows\\System32', SAFE_VALUE: 'kept' },
    })
    expect(calls[1]).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['scripts/prepare-runtime.ts'],
      cwd: 'C:\\repo\\dsh-plugin-desktop',
      env: {
        PATH: 'C:\\Windows\\System32',
        SAFE_VALUE: 'kept',
        DSH_RUNTIME_PLATFORM: 'win32',
        DSH_WIN7_ELECTRON_NODE: '1',
      },
    })
    expect(calls[2]).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: [
        'C:\\repo\\node_modules\\electron-builder\\cli.js',
        '--win',
        'nsis',
        '--x64',
        '--publish',
        'never',
        '--config.win.signExecutable=false',
        '--config.npmRebuild=false',
        '--config.electronFuses.onlyLoadAppFromAsar=false',
        '--config.directories.output=dist/win7',
        '--config.electronVersion=40.2.0',
      ],
      cwd: 'C:\\repo\\dsh-plugin-desktop',
      env: {
        PATH: 'C:\\Windows\\System32',
        SAFE_VALUE: 'kept',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
        DSH_ELECTRON_BUILDER_TRAVERSAL_ONLY: '1',
        DSH_WIN7: '1',
      },
    })
    expect(calls[3]).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-installer.ts'],
      cwd: 'C:\\repo\\dsh-plugin-desktop',
      env: {
        PATH: 'C:\\Windows\\System32',
        SAFE_VALUE: 'kept',
        DSH_DIST_DIR: 'C:\\repo\\dsh-plugin-desktop\\dist\\win7',
      },
    })
    expect(logs).toContain(
      'Building an unsigned Windows 7 x64 installer with Electron 40.2.0.',
    )
  })

  it('passes custom electronDist when specified', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []
    const customDist = 'C:\\custom-win7-electron'

    packageWindows7Installer({
      ...options(calls, logs),
      electronDist: customDist,
      env: {
        ...options(calls).env,
        DSH_PACKAGE_CHECK_ALREADY_RAN: '1',
      },
    })

    expect(calls).toHaveLength(3)
    expect(calls[1]?.args).toContain(`--config.electronDist=${customDist}`)
    expect(logs).toContain(`Using custom Win7 Electron distribution at ${customDist}`)
  })

  it('builds an unsigned portable ZIP target for Win7 and verifies it', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []
    const value = {
      ...options(calls, logs),
      verifier: 'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-portable.ts',
      env: {
        ...options(calls).env,
        DSH_PACKAGE_CHECK_ALREADY_RAN: '1',
      },
    }

    packageWindows7Artifact(value, 'zip', 'portable archive')

    expect(calls[1]?.args).toEqual([
      'C:\\repo\\node_modules\\electron-builder\\cli.js',
      '--win',
      'zip',
      '--x64',
      '--publish',
      'never',
      '--config.win.signExecutable=false',
      '--config.npmRebuild=false',
      '--config.electronFuses.onlyLoadAppFromAsar=false',
      '--config.directories.output=dist/win7',
      '--config.electronVersion=40.2.0',
    ])
    expect(calls[2]?.args).toEqual([
      'C:\\repo\\dsh-plugin-desktop\\scripts\\verify-win-portable.ts',
    ])
    expect(logs).toContain(
      'Building an unsigned Windows 7 x64 portable archive with Electron 40.2.0.',
    )
  })

  it.each([
    ['darwin', 'x64', '22.23.2', 'must be built on Windows or Linux'],
    ['win32', 'arm64', '22.23.2', 'requires x64 Node'],
    ['win32', 'x64', '25.0.0', 'Node 22.19+ or Node 24.x'],
  ] as const)(
    'rejects unsupported host %s/%s with Node %s before running commands',
    (platform, arch, nodeVersion, message) => {
      const calls: CommandCall[] = []
      const value = { ...options(calls), platform, arch, nodeVersion }

      expect(() => packageWindows7Installer(value)).toThrow(message)
      expect(calls).toEqual([])
    },
  )
})

describe('verifyWin7Executable', () => {
  it('accepts valid Win7 lowered PE binary (os 5.2, subsystem 5.2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-win7-test-'))
    temporaryRoots.push(dir)
    const exe = join(dir, 'DSH Desktop.exe')
    writeFileSync(exe, createSyntheticPe({ osMajor: 5, osMinor: 2, subMajor: 5, subMinor: 2 }))

    expect(() => verifyWin7Executable(exe)).not.toThrow()
  })

  it('rejects binary with modern OS version (os 10.0)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-win7-test-'))
    temporaryRoots.push(dir)
    const exe = join(dir, 'DSH Desktop.exe')
    writeFileSync(exe, createSyntheticPe({ osMajor: 10, osMinor: 0, subMajor: 10, subMinor: 0 }))

    expect(() => verifyWin7Executable(exe)).toThrow('expected PE os=5.2 subsystem=5.2')
  })

  it('rejects missing executable', () => {
    expect(() => verifyWin7Executable('C:\\non-existent\\DSH Desktop.exe')).toThrow(
      'application executable missing',
    )
  })
})
