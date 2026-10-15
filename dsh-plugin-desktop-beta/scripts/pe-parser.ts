/** Self-contained Windows PE binary parser and Win7 compatibility auditor. */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface PeImport {
  readonly dll: string
  readonly name: string
}

export interface PeImports {
  readonly dlls: Set<string>
  readonly functions: Set<string>
  readonly imports: readonly PeImport[]
}

export interface PeVersion {
  readonly os: string
  readonly subsystem: string
  readonly machine: string
}

export type NativeAuditDecisionKind =
  | 'compatible'
  | 'patched'
  | 'disabled-on-win7'
  | 'lazy-loaded'
  | 'lazy-loaded-risk'
  | 'unapproved'
  | 'not-applicable'

export interface Win7NativeDecision {
  readonly match: string
  readonly decision: NativeAuditDecisionKind
  readonly note: string
}

export interface NativeAuditEntry {
  readonly file: string
  readonly format: 'pe' | 'non-pe'
  readonly riskyImports: readonly PeImport[]
  readonly decision: NativeAuditDecisionKind
  readonly note?: string
}

export const WIN7_UNSUPPORTED_FUNCTIONS = new Set([
  'AdjustWindowRectExForDpi',
  'CreateFile2',
  'CreatePseudoConsole',
  'DiscardVirtualMemory',
  'GetDpiForWindow',
  'GetSystemTimePreciseAsFileTime',
  'GetThreadDescription',
  'PrefetchVirtualMemory',
  'ProcessPrng',
  'SetThreadDescription',
  'WaitOnAddress',
  'WakeByAddressAll',
  'WakeByAddressSingle',
])

export const WIN7_UNSUPPORTED_DLL_PREFIXES = [
  'api-ms-win-core-synch-l1-2-0',
  'api-ms-win-core-winrt',
  'api-ms-win-core-winrt-error',
  'bcryptprimitives',
] as const

function toBuffer(fileOrBuffer: string | Buffer): Buffer {
  return typeof fileOrBuffer === 'string' ? readFileSync(fileOrBuffer) : fileOrBuffer
}

/** Check if the given buffer or file path contains a valid Windows Portable Executable. */
export function isPeFile(fileOrBuffer: string | Buffer): boolean {
  let bytes: Buffer
  try {
    bytes = toBuffer(fileOrBuffer)
  } catch {
    return false
  }
  if (bytes.length < 0x40) return false
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) return false // 'MZ'

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  return peOffset + 4 <= bytes.length && bytes[peOffset] === 0x50 && bytes[peOffset + 1] === 0x45 // 'PE\0\0'
}

/** Read OS and subsystem version fields from the PE Optional Header. */
export function readPeVersions(fileOrBuffer: string | Buffer): PeVersion {
  const bytes = toBuffer(fileOrBuffer)
  if (!isPeFile(bytes)) {
    throw new Error('Not a valid Windows PE image')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  const machine = `0x${view.getUint16(peOffset + 4, true).toString(16)}`
  const optionalHeader = peOffset + 24
  const osMajor = view.getUint16(optionalHeader + 40, true)
  const osMinor = view.getUint16(optionalHeader + 42, true)
  const subMajor = view.getUint16(optionalHeader + 48, true)
  const subMinor = view.getUint16(optionalHeader + 50, true)

  return {
    machine,
    os: `${String(osMajor)}.${String(osMinor)}`,
    subsystem: `${String(subMajor)}.${String(subMinor)}`,
  }
}

/** Parse import directory and resolve imported DLL names and function symbols. */
export function readPeImports(fileOrBuffer: string | Buffer): PeImports {
  const bytes = toBuffer(fileOrBuffer)
  if (!isPeFile(bytes)) {
    throw new Error('Not a valid Windows PE image')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const peOffset = view.getUint32(0x3c, true)
  const sections = view.getUint16(peOffset + 6, true)
  const optionalHeader = peOffset + 24
  const optionalHeaderSize = view.getUint16(peOffset + 20, true)
  const magic = view.getUint16(optionalHeader, true)
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : 96)
  const importRva = view.getUint32(dataDirectories + 8, true)
  const sectionTable = optionalHeader + optionalHeaderSize

  const dlls = new Set<string>()
  const functions = new Set<string>()
  const imports: PeImport[] = []

  if (dataDirectories + 16 > view.byteLength) return { dlls, functions, imports }

  if (importRva === 0) return { dlls, functions, imports }

  const rvaToOffset = (rva: number): number => {
    for (let i = 0; i < sections; i++) {
      const section = sectionTable + i * 40
      const virtualSize = view.getUint32(section + 8, true)
      const virtualAddress = view.getUint32(section + 12, true)
      const rawSize = view.getUint32(section + 16, true)
      const rawPointer = view.getUint32(section + 20, true)
      const size = Math.max(virtualSize, rawSize)
      if (rva >= virtualAddress && rva < virtualAddress + size) {
        return rawPointer + (rva - virtualAddress)
      }
    }
    throw new Error(`RVA 0x${rva.toString(16)} is outside PE sections`)
  }

  const readString = (offset: number): string => {
    const chars: number[] = []
    for (let i = offset; i < view.byteLength; i++) {
      const byte = view.getUint8(i)
      if (byte === 0) break
      chars.push(byte)
    }
    return new TextDecoder('ascii').decode(new Uint8Array(chars))
  }

  try {
    for (
      let descriptor = rvaToOffset(importRva);
      descriptor + 20 <= view.byteLength;
      descriptor += 20
    ) {
      const originalFirstThunk = view.getUint32(descriptor, true)
      const nameRva = view.getUint32(descriptor + 12, true)
      const firstThunk = view.getUint32(descriptor + 16, true)
      if (originalFirstThunk === 0 && nameRva === 0 && firstThunk === 0) break

      const dll = readString(rvaToOffset(nameRva))
      dlls.add(dll)
      const thunkOffset = rvaToOffset(originalFirstThunk || firstThunk)
      const thunkStep = magic === 0x20b ? 8 : 4
      for (
        let thunk = thunkOffset;
        thunk + thunkStep <= view.byteLength;
        thunk += thunkStep
      ) {
        const value = magic === 0x20b
          ? view.getBigUint64(thunk, true)
          : BigInt(view.getUint32(thunk, true))
        if (value === 0n) break
        const ordinalFlag = magic === 0x20b ? 0x8000000000000000n : 0x80000000n
        if ((value & ordinalFlag) !== 0n) continue
        const name = readString(rvaToOffset(Number(value)) + 2)
        functions.add(name)
        imports.push({ dll, name })
      }
    }
  } catch {
    // Malformed or truncated import section; return partial resolved imports
  }

  return { dlls, functions, imports }
}

/** Check imports against known Windows 7 incompatible APIs. */
export function collectWin7RiskyImports(imports: PeImports): PeImport[] {
  const riskyImports: PeImport[] = []

  for (const dll of imports.dlls) {
    const normalized = dll.toLowerCase().replace(/\.dll$/u, '')
    if (WIN7_UNSUPPORTED_DLL_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
      riskyImports.push({ dll, name: '*' })
    }
  }

  for (const { dll, name } of imports.imports) {
    if (WIN7_UNSUPPORTED_FUNCTIONS.has(name)) {
      riskyImports.push({ dll, name })
    }
  }

  return riskyImports
}

function walkFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...walkFiles(full))
    } else {
      results.push(full)
    }
  }
  return results
}

/** Audit all PE binaries (.exe, .dll, .node) inside an application directory against Win7 rules. */
export function auditNativeBinaries(
  targetDir: string,
  decisions: readonly Win7NativeDecision[],
): { readonly entries: NativeAuditEntry[]; readonly failures: string[] } {
  const files = walkFiles(targetDir).filter(file => /\.(?:exe|dll|node)$/iu.test(file))
  const entries: NativeAuditEntry[] = []
  const failures: string[] = []

  for (const file of files) {
    const relativePath = relative(targetDir, file).split(sep).join('/')
    if (!isPeFile(file)) {
      entries.push({
        file: relativePath,
        format: 'non-pe',
        riskyImports: [],
        decision: 'not-applicable',
        note: 'Skipped because this native file is not a Windows PE binary.',
      })
      continue
    }

    const imports = readPeImports(file)
    const riskyImports = collectWin7RiskyImports(imports)
    const decision = decisions.find(item => relativePath.includes(item.match))

    const computedDecision: NativeAuditDecisionKind = decision?.decision
      ?? (riskyImports.length > 0 ? 'unapproved' : 'compatible')

    entries.push({
      file: relativePath,
      format: 'pe',
      riskyImports,
      decision: computedDecision,
      ...(decision?.note === undefined ? {} : { note: decision.note }),
    })

    if (riskyImports.length > 0 && decision === undefined) {
      failures.push(
        `${relativePath}: unapproved risky imports: ${riskyImports.map(item => `${item.dll}!${item.name}`).join(', ')}`,
      )
    }
    if (riskyImports.length > 0 && decision?.decision === 'patched') {
      failures.push(
        `${relativePath}: patched native binary still has risky imports: ${riskyImports.map(item => `${item.dll}!${item.name}`).join(', ')}`,
      )
    }
  }

  return { entries, failures }
}

/** Render a markdown report from audit entries. */
export function renderNativeAuditMarkdown(entries: readonly NativeAuditEntry[]): string {
  const lines = [
    '# Windows 7 Native Audit Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '| File | Format | Decision | Risky Imports | Notes |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ]

  for (const entry of entries) {
    const risky = entry.riskyImports.length > 0
      ? entry.riskyImports.map(item => `\`${item.dll}!${item.name}\``).join('<br>')
      : 'None'
    const note = entry.note ?? '-'
    lines.push(`| \`${entry.file}\` | ${entry.format} | ${entry.decision} | ${risky} | ${note} |`)
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}
