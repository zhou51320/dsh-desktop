import { describe, expect, it } from 'vitest'
import {
  collectWin7RiskyImports,
  isPeFile,
  readPeImports,
  readPeVersions,
  renderNativeAuditMarkdown,
  type NativeAuditEntry,
  type PeImports,
} from '../scripts/pe-parser.ts'

function createSyntheticPe(options: {
  readonly osMajor?: number
  readonly osMinor?: number
  readonly subMajor?: number
  readonly subMinor?: number
} = {}): Buffer {
  // Allocate buffer large enough for DOS header, PE header, Optional Header and data directories
  const buf = Buffer.alloc(512)
  // DOS header signature 'MZ'
  buf.write('MZ', 0, 'ascii')
  // Offset to PE signature at 0x3c
  buf.writeUInt32LE(0x80, 0x3c)
  // PE signature 'PE\0\0' at 0x80
  buf.write('PE\0\0', 0x80, 'binary')
  // Machine at 0x84 (IMAGE_FILE_MACHINE_AMD64 = 0x8664)
  buf.writeUInt16LE(0x8664, 0x84)
  // NumberOfSections at 0x86
  buf.writeUInt16LE(0, 0x86)
  // SizeOfOptionalHeader at 0x94
  buf.writeUInt16LE(0x70, 0x94)
  // Optional Header magic (0x20b = PE32+) at 0x98 (0x80 + 24)
  buf.writeUInt16LE(0x20b, 0x98)
  // MajorOperatingSystemVersion at optionalHeader + 40 = 0x98 + 40 = 0xc0
  buf.writeUInt16LE(options.osMajor ?? 5, 0xc0)
  // MinorOperatingSystemVersion at 0xc2
  buf.writeUInt16LE(options.osMinor ?? 2, 0xc2)
  // MajorSubsystemVersion at optionalHeader + 48 = 0x98 + 48 = 0xc8
  buf.writeUInt16LE(options.subMajor ?? 5, 0xc8)
  // MinorSubsystemVersion at 0xca
  buf.writeUInt16LE(options.subMinor ?? 2, 0xca)

  return buf
}

describe('PE parser and Win7 compatibility auditor', () => {
  it('identifies non-PE buffers and files as invalid', () => {
    expect(isPeFile(Buffer.from('not a pe header'))).toBe(false)
    expect(isPeFile(Buffer.alloc(30))).toBe(false)
  })

  it('validates synthetic PE images and extracts OS / subsystem versions', () => {
    const pe = createSyntheticPe({ osMajor: 5, osMinor: 2, subMajor: 5, subMinor: 2 })
    expect(isPeFile(pe)).toBe(true)

    const versions = readPeVersions(pe)
    expect(versions.os).toBe('5.2')
    expect(versions.subsystem).toBe('5.2')
    expect(versions.machine).toBe('0x8664')
  })

  it('extracts imports gracefully from a PE with no import table', () => {
    const pe = createSyntheticPe()
    const result = readPeImports(pe)
    expect(result.dlls.size).toBe(0)
    expect(result.functions.size).toBe(0)
    expect(result.imports).toEqual([])
  })

  it('detects known Windows 7 unsupported functions and API set DLLs', () => {
    const imports: PeImports = {
      dlls: new Set(['kernel32.dll', 'api-ms-win-core-winrt-l1-1-0.dll', 'user32.dll']),
      functions: new Set(['GetSystemTimePreciseAsFileTime', 'CreatePseudoConsole', 'GetDriveTypeW']),
      imports: [
        { dll: 'kernel32.dll', name: 'GetSystemTimePreciseAsFileTime' },
        { dll: 'kernel32.dll', name: 'CreatePseudoConsole' },
        { dll: 'kernel32.dll', name: 'GetDriveTypeW' },
      ],
    }

    const risky = collectWin7RiskyImports(imports)
    expect(risky).toEqual([
      { dll: 'api-ms-win-core-winrt-l1-1-0.dll', name: '*' },
      { dll: 'kernel32.dll', name: 'GetSystemTimePreciseAsFileTime' },
      { dll: 'kernel32.dll', name: 'CreatePseudoConsole' },
    ])
  })

  it('renders a formatted markdown table for audit entries', () => {
    const entries: NativeAuditEntry[] = [
      {
        file: 'node_modules/koffi/koffi.node',
        format: 'pe',
        riskyImports: [],
        decision: 'compatible',
        note: 'Classic Win32 APIs only',
      },
      {
        file: 'node_modules/node-pty/conpty.node',
        format: 'pe',
        riskyImports: [{ dll: 'kernel32.dll', name: 'CreatePseudoConsole' }],
        decision: 'disabled-on-win7',
        note: 'Gated on Win7',
      },
    ]

    const md = renderNativeAuditMarkdown(entries)
    expect(md).toContain('# Windows 7 Native Audit Report')
    expect(md).toContain('`node_modules/koffi/koffi.node`')
    expect(md).toContain('`node_modules/node-pty/conpty.node`')
    expect(md).toContain('`kernel32.dll!CreatePseudoConsole`')
    expect(md).toContain('disabled-on-win7')
  })
})
