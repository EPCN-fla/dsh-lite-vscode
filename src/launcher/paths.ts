/**
 * Path translation between Windows and WSL path namespaces.
 *
 * Strategy: probe the WSL automount root once (via `wslpath -u C:\\`),
 * then do pure string mapping for drvfs-style paths; anything exotic
 * (UNC shares, non-drvfs locations) falls back to shelling out to wslpath.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PathMapper } from './types.js'

const execFileP = promisify(execFile)

/** Same-side launcher: paths need no translation. */
export const identityMapper: PathMapper = {
  toDsh: async p => p,
  fromDsh: async p => p,
}

function run(cmd: string, args: string[]): Promise<string> {
  return execFileP(cmd, args, { timeout: 10_000 }).then(r => r.stdout.trim())
}

/** win -> posix separators. */
function toPosixRest(p: string): string {
  return p.replace(/\\/g, '/')
}

/** posix -> win separators. */
function toWinRest(p: string): string {
  return p.replace(/\//g, '\\')
}

/** Maps Windows paths to WSL paths. Runs on a Windows host; shells into WSL for fallbacks. */
export class WinToWslMapper implements PathMapper {
  private mountRoot: string | undefined // e.g. "/mnt"
  private cache = new Map<string, string>()

  constructor(
    private distro?: string,
    private mountRootOverride?: string,
  ) {}

  private wsl(args: string[]): Promise<string> {
    const base = this.distro ? ['-d', this.distro] : []
    return run('wsl.exe', [...base, '-e', ...args])
  }

  private async probeMountRoot(): Promise<string> {
    if (this.mountRootOverride) return this.mountRootOverride
    if (this.mountRoot) return this.mountRoot
    // wslpath -u 'C:\' -> '/mnt/c/' ; root = strip trailing 'c/'
    const cRoot = await this.wsl(['wslpath', '-u', 'C:\\'])
    this.mountRoot = cRoot.replace(/[\\/]?c[\\/]?$/i, '').replace(/\/+$/, '') || '/mnt'
    return this.mountRoot
  }

  async toDsh(p: string): Promise<string> {
    const hit = this.cache.get(p)
    if (hit) return hit
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
    if (m) {
      const root = await this.probeMountRoot()
      const out = `${root}/${m[1].toLowerCase()}/${toPosixRest(m[2])}`.replace(/\/+$/, '') || '/'
      this.cache.set(p, out)
      return out
    }
    // UNC or otherwise unusual: ask wslpath.
    const out = await this.wsl(['wslpath', '-u', p])
    this.cache.set(p, out)
    return out
  }

  async fromDsh(p: string): Promise<string> {
    const root = await this.probeMountRoot()
    const m = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([a-z])($|/(.*)$)`).exec(p)
    if (m) {
      return `${m[1].toUpperCase()}:\\${m[3] ? toWinRest(m[3]) : ''}`
    }
    return this.wsl(['wslpath', '-w', p])
  }
}

/** Maps WSL paths to Windows paths. Runs inside WSL; wslpath is local and fast. */
export class WslToWinMapper implements PathMapper {
  private cache = new Map<string, string>()

  async toDsh(p: string): Promise<string> {
    // dsh runs on Windows; VS Code-side path p is a WSL path.
    const hit = this.cache.get(p)
    if (hit) return hit
    const out = await run('wslpath', ['-w', p])
    this.cache.set(p, out)
    return out
  }

  async fromDsh(p: string): Promise<string> {
    return run('wslpath', ['-u', p])
  }
}
