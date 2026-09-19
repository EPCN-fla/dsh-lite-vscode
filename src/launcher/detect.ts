/** Resolve which launcher implements the requested topology. */
import type { DshConfig, HostSide, Launcher } from './types.js'
import { LocalLauncher } from './local.js'
import { WslLauncher } from './wsl.js'
import { WindowsLauncher } from './windows.js'

/** Detect where THIS extension host process runs. */
export function detectHostSide(remoteName: string | undefined, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): HostSide {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (remoteName === 'wsl' || env.WSL_DISTRO_NAME !== undefined) return 'wsl'
  return 'linux'
}

export class LauncherConfigError extends Error {}

export function resolveLauncher(host: HostSide, cfg: DshConfig): Launcher {
  const target = cfg.runtime === 'auto'
    ? (host === 'windows' ? 'windows' : 'same-posix')
    : cfg.runtime

  switch (`${host}:${target}`) {
    case 'windows:windows':
      return new LocalLauncher(cfg, 'win32')
    case 'windows:wsl':
      return new WslLauncher(cfg)
    case 'wsl:same-posix':
      return new LocalLauncher(cfg, 'linux')
    case 'wsl:windows':
      return new WindowsLauncher(cfg)
    case 'linux:same-posix':
    case 'macos:same-posix':
      return new LocalLauncher(cfg, process.platform)
    case 'linux:windows':
    case 'macos:windows':
    case 'linux:wsl':
    case 'macos:wsl':
      throw new LauncherConfigError(
        `dsh.runtime="${cfg.runtime}" is not supported on a ${host} host. ` +
        `Supported: auto (same side), or wsl/windows cross-side only between Windows and WSL.`,
      )
    default:
      throw new LauncherConfigError(`Unsupported topology: host=${host}, runtime=${cfg.runtime}`)
  }
}
