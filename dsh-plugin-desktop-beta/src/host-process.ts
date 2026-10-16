/** Electron owns the child lifetime; the child owns the unchanged DSH Web server. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { serializeHostEnvironment } from './host-launch-environment.ts'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { HostRpc, type HostPort } from './host-rpc.ts'
import { bundledNodeExecutable } from './desktop-runtime-environment.ts'
import { bindNativeRuntime, runtimeSnapshot } from './host-runtime-bridge.ts'
import type { DesktopHostOptions } from './host-bootstrap.ts'
import type { DesktopRuntime } from './runtime.ts'
import type { DesktopStartupGenerationHost } from './startup-generation.ts'
import type { DesktopLanHttpsRuntimeOptions } from './lan-https-runtime.ts'

export interface IsolatedHostOptions {
  host: DesktopHostOptions
  runtime: DesktopRuntime
  rendererToken: string
  prepareCertificate: NonNullable<DesktopLanHttpsRuntimeOptions['prepareCertificate']>
  bindHost(host: DesktopStartupGenerationHost): void
  requestQuit(code: number): void
  onFailure(error: Error, exit: IsolatedHostExit): void
}

/** What an unexpected Host exit leaves behind for evidence. */
export interface IsolatedHostExit {
  /** Electron's reported code. A terminated Host reports the terminator's code, not a self-chosen one. */
  readonly exitCode: number
  /** Milliseconds between fork and exit; separates an instant death from one hours in. */
  readonly uptimeMs: number
  /**
   * The Host's last stderr output, bounded to {@link HOST_STDERR_TAIL_CHARS}. A fatal Host writes
   * its reason there (the fail-loud diagnostic, or Node's own crash stack) and nowhere else.
   */
  readonly stderrTail: string
}

/** Enough for a fail-loud diagnostic with its inspected cause chain, small enough for one log entry. */
export const HOST_STDERR_TAIL_CHARS = 16 * 1024

/** The Desktop log entry for an unexpected Host exit: the reason, then what the Host said last. */
export function formatUnexpectedHostExit(error: Error, exit: IsolatedHostExit): string {
  const tail = exit.stderrTail.trimEnd()
  return tail === '' ? error.message : `${error.message}\nLast DSH Host stderr:\n${tail}`
}

export async function startIsolatedDesktopHost(options: IsolatedHostOptions): Promise<void> {
  const forkedAt = performance.now()
  const child = spawn(bundledNodeExecutable(process.resourcesPath), [
    fileURLToPath(new URL('./host-process-entry.js', import.meta.url)),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd(), env: { ...process.env }, windowsHide: true,
  })
  const stderrDecoder = new StringDecoder('utf8')
  let stderrTail = ''
  child.stderr.on('data', (data: Buffer) => {
    process.stderr.write(data)
    stderrTail = (stderrTail + stderrDecoder.write(data)).slice(-HOST_STDERR_TAIL_CHARS)
  })
  const rpc = new HostRpc(stdioSupervisorPort(child), 120_000)
  const releaseNative = bindNativeRuntime(rpc, options.runtime)
  rpc.handle('certificate', () => options.prepareCertificate())
  rpc.handle('quit', ([code]) => { setImmediate(() => options.requestQuit(code)) })
  let stopping = false
  let exited = false
  let booted = false
  let resolveExit!: () => void
  const exit = new Promise<void>(resolve => { resolveExit = resolve })
  child.once('exit', (code, signal) => {
    exited = true
    const exitCode = code ?? 1
    const reported = code === null ? `signal ${String(signal)}` : String(code)
    rpc.close(`DSH Host exited (${reported})`)
    resolveExit()
    if (!stopping && booted) {
      options.onFailure(
        new Error(`DSH Host exited (${reported}); restart the application to reconnect`),
        { exitCode, uptimeMs: Math.max(0, performance.now() - forkedAt), stderrTail },
      )
    }
  })
  child.once('error', (cause: Error) => {
    exited = true
    rpc.close(`DSH Host failed to start: ${cause.message}`)
    resolveExit()
  })
  let stopTask: Promise<void> | undefined
  const stop = (): Promise<void> => stopTask ??= (async () => {
    stopping = true
    if (!exited) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 3_000)
      try { await rpc.call('stop', [], controller.signal) } catch { /* terminate an unresponsive Host */ }
      finally { clearTimeout(timeout) }
      if (!exited) child.kill()
      const timeoutExit = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DSH Host termination was not confirmed')), 1_000)
        void exit.then(() => clearTimeout(timer))
      })
      await Promise.race([exit, timeoutExit])
    }
    await releaseNative()
    rpc.close()
  })()
  options.bindHost({ fiber: { dispose: stop } })
  try {
    const { desktopLaunchEnvironment, ...host } = options.host
    await rpc.call('boot', [{ ...host, launchEnvironmentLayers: serializeHostEnvironment(desktopLaunchEnvironment) }, runtimeSnapshot(options.runtime), options.rendererToken])
    booted = true
  } catch (cause) {
    await stop()
    throw cause
  }
}

/** Adapt one packaged Node child stdio stream to the existing Host RPC protocol. */
function stdioSupervisorPort(child: ChildProcessWithoutNullStreams): HostPort {
  const receivers: ((message: unknown) => void)[] = []
  const decoder = new StringDecoder('utf8')
  let buffer = ''
  child.stdout.on('data', (data: Buffer) => {
    buffer += decoder.write(data)
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      try {
        const message = JSON.parse(line) as unknown
        for (const receive of receivers) receive(message)
      } catch (cause) {
        process.stderr.write(`dsh-plugin-desktop: discarding malformed Host message: ${cause instanceof Error ? cause.message : String(cause)}\n`)
      }
    }
  })
  return {
    send: message => { child.stdin.write(`${JSON.stringify(message)}\n`) },
    listen: receive => {
      receivers.push(receive)
      return () => {
        const at = receivers.indexOf(receive)
        if (at !== -1) receivers.splice(at, 1)
      }
    },
  }
}
