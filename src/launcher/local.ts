/** Same-side launcher: cases 1 (WSL↔WSL) and 4 (Windows↔Windows). */
import type { DshConfig, Launcher, LaunchSpec } from './types.js'
import { identityMapper } from './paths.js'
import { posixBootstrap, posixDoctor } from './shellenv.js'

export class LocalLauncher implements Launcher {
  readonly label: string
  readonly paths = identityMapper

  constructor(
    private cfg: DshConfig,
    private platform: NodeJS.Platform,
  ) {
    this.label = platform === 'win32' ? 'windows-host → windows' : 'wsl-host → wsl (same side)'
  }

  async buildLaunchSpec(dshWorkspaceCwd: string): Promise<LaunchSpec> {
    const full = `${this.cfg.command} --profile ${this.cfg.profile}`
    if (this.platform === 'win32') {
      // npx/dsh are .cmd shims on Windows: go through cmd.exe. cwd via spawn —
      // a `cd /d "…"` payload inside /c breaks under libuv's argument quoting.
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', full], cwd: dshWorkspaceCwd, env: this.cfg.env, shell: false }
    }
    return {
      command: '/bin/bash',
      args: ['-lc', `${posixBootstrap()}; cd ${shellQuote(dshWorkspaceCwd)} && exec ${full}`],
      cwd: dshWorkspaceCwd,
      env: this.cfg.env,
      shell: false,
    }
  }

  async buildDoctorSpec(): Promise<LaunchSpec> {
    if (this.platform === 'win32') {
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'where node & node --version & where dsh & where npx'], shell: false }
    }
    return { command: '/bin/bash', args: ['-lc', posixDoctor()], shell: false }
  }
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
