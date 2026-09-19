/**
 * Case 3: VS Code extension host inside WSL (Remote-WSL), dsh on Windows.
 * WSL binfmt interop lets us spawn Windows executables directly and pipes stdio.
 * Caveat: WSL-native paths map to \\wsl$ UNC on the Windows side; dsh on Windows
 * can read them but performance is poor. Prefer running dsh on the side that
 * owns the workspace files.
 */
import type { DshConfig, Launcher, LaunchSpec } from './types.js'
import { WslToWinMapper } from './paths.js'

export class WindowsLauncher implements Launcher {
  readonly label = 'wsl-host → windows'
  readonly paths = new WslToWinMapper()

  constructor(private cfg: DshConfig) {}

  async buildLaunchSpec(dshWorkspaceCwdWsl: string): Promise<LaunchSpec> {
    const winCwd = await this.paths.toDsh(dshWorkspaceCwdWsl)
    const envPrefix = Object.entries(this.cfg.env)
      .map(([k, v]) => `set "${k}=${v}" &&`)
      .join(' ')
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', `${envPrefix} cd /d "${winCwd}" && ${this.cfg.command} --profile ${this.cfg.profile}`],
      shell: false,
    }
  }

  async buildDoctorSpec(): Promise<LaunchSpec> {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'where node & node --version & where dsh & where npx'], shell: false }
  }
}
