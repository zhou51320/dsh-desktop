/**
 * Keep plugin metadata resolution independent from Node's private ESM loader.
 *
 * Some Windows 7 Node distributions deliberately cannot load
 * node-addon-require-builtin, which Cordis otherwise uses to reach that
 * private API.  Metadata only needs synchronous package resolution, which the
 * public CommonJS resolver can provide.  Plugin execution remains on the
 * profile resolver installed by the Host bootstrap.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Install a public-API fallback when the private Node loader is unavailable. */
export function installPluginMetadataResolverFallback(): void {
  const { ModuleLoader } = createRequire(import.meta.url)('@deepseek-ai/cordis-plugin-loader') as typeof import('@deepseek-ai/cordis-plugin-loader')
  if (ModuleLoader.fromInternal() !== undefined) return
  ModuleLoader.fromInternal = () => ({
    version: 'v1',
    resolveSync(specifier: string, parentURL: string) {
      return { format: 'module', url: pathToFileURL(createRequire(parentURL).resolve(specifier)).href }
    },
  } as never)
}
