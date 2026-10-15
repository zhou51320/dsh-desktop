/** Build an unsigned Windows 7-compatible x64 portable ZIP archive on a native Windows host. */

import { fileURLToPath } from 'node:url'
import {
  createWindows7PackageOptions,
  packageWindows7Artifact,
} from './package-win7.ts'

const invokedPath = process.argv[1]
if (invokedPath !== undefined && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    packageWindows7Artifact(
      createWindows7PackageOptions('./verify-win-portable.ts'),
      'zip',
      'portable archive',
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
