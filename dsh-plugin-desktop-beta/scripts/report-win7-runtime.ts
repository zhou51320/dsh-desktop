/** Report Windows 7 runtime provenance and PE header integrity. */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectWin7RiskyImports,
  isPeFile,
  readPeImports,
  readPeVersions,
  type PeVersion,
} from './pe-parser.ts'

interface FileInspection {
  readonly path: string
  readonly size: number
  readonly sha256: string
  readonly pe: PeVersion | null
  readonly risks: readonly string[]
}

interface RuntimeInspection {
  readonly path: string
  readonly version: string | null
  readonly executable: string
  readonly files: readonly FileInspection[]
  readonly summary: {
    readonly fileCount: number
    readonly peFileCount: number
    readonly loweredPeFiles: readonly string[]
    readonly riskFiles: readonly { readonly path: string; readonly risks: readonly string[] }[]
  }
}

function findExecutable(dir: string): string {
  for (const name of ['electron.exe', 'DSH Desktop.exe', 'DSH Desktop Beta.exe', 'DSH-Desktop.exe']) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  throw new Error(`Runtime directory must contain electron.exe, DSH Desktop.exe, or DSH Desktop Beta.exe: ${dir}`)
}

function runtimeFiles(dir: string): string[] {
  const known = [
    'electron.exe',
    'DSH Desktop.exe',
    'DSH Desktop Beta.exe',
    'chrome_elf.dll',
    'd3dcompiler_47.dll',
    'dxcompiler.dll',
    'dxil.dll',
    'ffmpeg.dll',
    'libEGL.dll',
    'libGLESv2.dll',
    'vk_swiftshader.dll',
    'vulkan-1.dll',
    'resources/app.asar',
  ]
  const topLevel = readdirSync(dir)
    .filter(name => name.endsWith('.exe') || name.endsWith('.dll'))
    .map(name => join(dir, name))
  const files = known.map(name => join(dir, name)).filter(file => existsSync(file))
  return Array.from(new Set([...files, ...topLevel]))
    .filter(file => statSync(file).isFile())
    .sort()
}

function inspectFile(file: string, root: string): FileInspection {
  const bytes = readFileSync(file)
  const isPe = isPeFile(bytes)
  const pe = isPe ? readPeVersions(bytes) : null
  const risks = isPe
    ? collectWin7RiskyImports(readPeImports(bytes)).map(item => `${item.dll}!${item.name}`)
    : []

  return {
    path: relative(root, file).split(sep).join('/'),
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pe,
    risks,
  }
}

function inspectRuntime(dir: string): RuntimeInspection {
  const executable = findExecutable(dir)
  const versionFile = join(dir, 'version')
  const files = runtimeFiles(dir).map(file => inspectFile(file, dir))
  const peFiles = files.filter(file => file.pe !== null)

  return {
    path: dir,
    version: existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : null,
    executable: relative(dir, executable).split(sep).join('/'),
    files,
    summary: {
      fileCount: files.length,
      peFileCount: peFiles.length,
      loweredPeFiles: peFiles
        .filter(file => file.pe?.os === '5.2' && file.pe.subsystem === '5.2')
        .map(file => file.path),
      riskFiles: peFiles
        .filter(file => file.risks.length > 0)
        .map(file => ({ path: file.path, risks: file.risks })),
    },
  }
}

function renderMarkdown(report: {
  readonly generatedAt: string
  readonly primary: RuntimeInspection
}): string {
  const lines = [
    '# Windows 7 Runtime Provenance Report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Runtime path: \`${report.primary.path}\``,
    `Runtime version: \`${report.primary.version ?? 'unknown'}\``,
    `Executable: \`${report.primary.executable}\``,
    `Total checked files: ${String(report.primary.summary.fileCount)}`,
    `Lowered PE (5.2) files: ${String(report.primary.summary.loweredPeFiles.length)}`,
    '',
    '## Files',
    '',
    '| Path | Size (bytes) | SHA-256 | PE OS / Subsystem | Risks |',
    '| :--- | :--- | :--- | :--- | :--- |',
  ]

  for (const file of report.primary.files) {
    const pe = file.pe ? `${file.pe.os} / ${file.pe.subsystem}` : 'N/A'
    const risks = file.risks.length > 0 ? file.risks.join('<br>') : 'None'
    lines.push(`| \`${file.path}\` | ${String(file.size)} | \`${file.sha256.slice(0, 16)}...\` | ${pe} | ${risks} |`)
  }

  lines.push('')
  return `${lines.join('\n')}\n`
}

function main(): void {
  const rawArgs = process.argv.slice(2)
  const inputArg = rawArgs.find(arg => !arg.startsWith('--'))
  const outIndex = rawArgs.indexOf('--out')
  const defaultDir = process.env.DSH_WIN7_ELECTRON_DIST ?? 'dist/win7/win-unpacked'
  const input = resolve(inputArg ?? defaultDir)
  const outArg = outIndex >= 0 ? rawArgs[outIndex + 1] : undefined
  const out = resolve(outArg ?? 'dist/win7/runtime-provenance')

  if (!existsSync(input)) {
    throw new Error(`Runtime directory not found: ${input}`)
  }

  const primary = inspectRuntime(input)
  const report = {
    generatedAt: new Date().toISOString(),
    primary,
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(`${out}.md`, renderMarkdown(report))
  console.log(`Wrote ${out}.json and ${out}.md`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
