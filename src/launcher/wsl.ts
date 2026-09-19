/**
 * Case 2: VS Code extension host on Windows, dsh inside WSL.
 * stdio pipes are forwarded through wsl.exe, so the ACP ndjson stream works end to end.
 * Note: no `--cd` flag (unsupported on older WSL builds) — cd happens in bash.
 */
import type { DshConfig, Launcher, LaunchSpec } from './types.js'
import { WinToWslMapper } from './paths.js'
import { posixBootstrap, posixDoctor } from './shellenv.js'
import { shellQuote } from './local.js'

export class WslLauncher implements Launcher {
  readonly label = 'windows-host → wsl'
  readonly paths: WinToWslMapper

  constructor(
    private cfg: DshConfig,
    mountRootOverride?: string,
  ) {
    this.paths = new WinToWslMapper(cfg.wslDistro || undefined, mountRootOverride)
  }

  private wslArgs(innerBash: string): string[] {
    return [
      ...(this.cfg.wslDistro ? ['-d', this.cfg.wslDistro] : []),
      '-e', 'bash', '-lc', innerBash,
    ]
  }

  async buildLaunchSpec(dshWorkspaceCwdWin: string): Promise<LaunchSpec> {
    // dshWorkspaceCwd is expressed in the VS Code (Windows) namespace here;
    // translate it for the WSL-side process.
    const wslCwd = await this.paths.toDsh(dshWorkspaceCwdWin)
    const exports = Object.entries(this.cfg.env)
      .map(([k, v]) => `export ${k}=${shellQuote(v)};`)
      .join(' ')
    const inner = `${posixBootstrap()}; ${exports} cd ${shellQuote(wslCwd)} && exec ${this.cfg.command} --profile ${this.cfg.profile}`
    return { command: 'wsl.exe', args: this.wslArgs(inner), shell: false }
  }

  async buildDoctorSpec(): Promise<LaunchSpec> {
    return { command: 'wsl.exe', args: this.wslArgs(posixDoctor()), shell: false }
  }
}
