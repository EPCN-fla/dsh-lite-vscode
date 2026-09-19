/**
 * Launcher abstraction: how to spawn `dsh --profile acp` on the target side,
 * and how to translate file paths between the VS Code side and the dsh side.
 *
 * Supported topologies:
 *   1. VS Code (Remote-WSL) + dsh (WSL)      -> LocalLauncher (same side)
 *   2. VS Code (Windows)    + dsh (WSL)      -> WslLauncher   (spawn via wsl.exe)
 *   3. VS Code (Remote-WSL) + dsh (Windows)  -> WindowsLauncher (spawn via interop)
 *   4. VS Code (Windows)    + dsh (Windows)  -> LocalLauncher (same side)
 */
import type { ChildProcess } from 'node:child_process'

/** What the extension needs to start an ACP server process. */
export interface LaunchSpec {
  command: string
  args: string[]
  /** Working directory for the child process (preferred over in-command `cd`, which breaks cmd.exe quoting). */
  cwd?: string
  env?: Record<string, string>
  /** Windows: spawn through cmd.exe (needed for npx .cmd shims). */
  shell?: boolean
}

export type HostSide = 'windows' | 'wsl' | 'linux' | 'macos'
export type RuntimeSetting = 'auto' | 'wsl' | 'windows'

/** Bidirectional path translation between VS Code-side and dsh-side paths. */
export interface PathMapper {
  /** VS Code-side absolute path -> dsh-side absolute path. */
  toDsh(p: string): Promise<string>
  /** dsh-side absolute path -> VS Code-side absolute path. */
  fromDsh(p: string): Promise<string>
}

export interface Launcher {
  /** Human-readable topology label for diagnostics, e.g. "windows-host → wsl". */
  readonly label: string
  readonly paths: PathMapper
  /** Build the spawn spec for the ACP server, given the dsh-side workspace cwd. */
  buildLaunchSpec(dshWorkspaceCwd: string): Promise<LaunchSpec>
  /** Build a diagnostic probe spec (used by the dsh.doctor command). */
  buildDoctorSpec(): Promise<LaunchSpec>
}

/** Loose shape of the extension's configuration (kept vscode-free for testability). */
export interface DshConfig {
  runtime: RuntimeSetting
  /** dsh profile to boot (default 'acp'; use 'acp-vscode' once the bridge plugin is installed). */
  profile: string
  command: string
  wslDistro: string
  env: Record<string, string>
}

export type SpawnedProcess = ChildProcess
