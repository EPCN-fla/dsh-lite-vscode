/**
 * BridgeManager: finds the dsh-vscode-bridge instance serving this workspace
 * via the centralized discovery dir ($DSH_HOME/vscode-bridge/<pid>.json),
 * keeps a live BridgeClient, and re-broadcasts events.
 *
 * Topology notes:
 *  - same-side (1/4): read the dir directly.
 *  - Windows host + WSL dsh (2): read via \\wsl.localhost\<distro>\… UNC;
 *    distro/home probed once through wsl.exe and cached.
 *  - WSL host + Windows dsh (3): unsupported (documented).
 * No extension-side pid liveness checks: the plugin sweeps stale files at boot.
 */
import * as vscode from 'vscode'
import * as os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BridgeClient, type BridgeCapabilities, type BridgeEvent } from './client.js'
import { readDiscoveryDir, pickEntry, type DiscoveryEntry } from './discovery.js'
import type { DshConfig } from '../launcher/types.js'

const execFileP = promisify(execFile)

export type BridgeState = 'off' | 'connecting' | 'on'

export class BridgeManager implements vscode.Disposable {
  client?: BridgeClient
  state: BridgeState = 'off'
  private pollTimer?: ReturnType<typeof setInterval>
  private reconnecting?: Promise<void>
  private disposables: vscode.Disposable[] = []
  private uncHomeCache?: string

  private readonly _onState = new vscode.EventEmitter<{ state: BridgeState; capabilities?: BridgeCapabilities }>()
  readonly onState = this._onState.event
  private readonly _onEvent = new vscode.EventEmitter<BridgeEvent>()
  readonly onEvent = this._onEvent.event

  constructor(
    private getConfig: () => DshConfig,
    private getLauncherPaths: () => { toDsh(p: string): Promise<string> },
    private out: vscode.OutputChannel,
  ) {}

  get capabilities(): BridgeCapabilities | undefined { return this.client?.capabilities }
  get isOn(): boolean { return this.state === 'on' && !!this.client }

  start(): void {
    void this.reconnect()
    // UNC/dir watching is unreliable across OS boundaries; polling is the primary channel.
    this.pollTimer = setInterval(() => { if (!this.isOn) void this.reconnect() }, 3000)
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reconnect()))
  }

  // ---------- discovery ----------

  private dshHomeGuess(): string {
    return this.getConfig().env['DSH_HOME'] ?? '' // empty = platform default below
  }

  private async discoveryDir(): Promise<string | undefined> {
    const host = process.platform === 'win32' ? 'windows' : (process.env.WSL_DISTRO_NAME || vscode.env.remoteName === 'wsl') ? 'wsl' : 'posix'
    const cfg = this.getConfig()
    const target = cfg.runtime === 'auto' ? host : cfg.runtime

    if (host === 'windows' && target === 'wsl') {
      // Read the WSL-side discovery dir through the UNC share.
      const probe = await this.probeWsl()
      if (!probe) return undefined
      const dshHome = this.dshHomeGuess() || `${probe.home}/.dsh`
      return `${probe.uncPrefix}${dshHome.replace(/\//g, '\\')}\\vscode-bridge`
    }
    if (target === 'windows' || host === 'windows') return undefined // topology 3: unsupported
    const home = this.dshHomeGuess() || `${os.homedir()}/.dsh`
    return `${home}/vscode-bridge`
  }

  /** Probe the WSL distro name + $HOME once; returns the UNC prefix and posix home. */
  private async probeWsl(): Promise<{ uncPrefix: string; home: string } | undefined> {
    if (this.wslProbeCache) return this.wslProbeCache
    try {
      const cfg = this.getConfig()
      const args = [...(cfg.wslDistro ? ['-d', cfg.wslDistro] : []), '-e', 'bash', '-lc', 'printf "%s|%s" "$WSL_DISTRO_NAME" "$HOME"']
      const r = await execFileP('wsl.exe', args, { timeout: 15_000 })
      const [distro, home] = r.stdout.trim().split('|')
      if (!distro || !home) return undefined
      this.wslProbeCache = { uncPrefix: `\\\\wsl.localhost\\${distro}`, home }
      return this.wslProbeCache
    } catch (e) {
      this.out.appendLine(`[bridge] wsl probe failed: ${(e as Error).message}`)
      return undefined
    }
  }

  private wslProbeCache?: { uncPrefix: string; home: string }

  // ---------- connect ----------

  async reconnect(): Promise<void> {
    this.reconnecting ??= (async () => {
      const dir = await this.discoveryDir()
      if (!dir) { this.teardown('no discovery dir for this topology'); return }
      const entries = await readDiscoveryDir(dir)
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!folder) { this.teardown('no workspace folder'); return }
      const dshCwd = await this.getLauncherPaths().toDsh(folder.uri.fsPath)
      const entry = pickEntry(entries, dshCwd, process.platform === 'win32')
      if (!entry) { this.teardown('no bridge entry for this workspace'); return }
      await this.connectEntry(entry)
    })()
    try { await this.reconnecting } finally { this.reconnecting = undefined }
  }

  private async connectEntry(entry: DiscoveryEntry): Promise<void> {
    if (this.client && this.connectedPid === entry.pid) return
    try {
      this.state = 'connecting'
      this._onState.fire({ state: 'connecting' })
      const client = await BridgeClient.connect(entry)
      this.client?.close()
      this.client = client
      this.connectedPid = entry.pid
      client.onEvent = e => this._onEvent.fire(e)
      client.onClose = () => this.teardown('connection closed')
      this.state = 'on'
      this.out.appendLine(`[bridge] connected pid=${entry.pid} v${client.handshake?.version} caps=${JSON.stringify(client.capabilities)}`)
      this._onState.fire({ state: 'on', capabilities: client.capabilities })
    } catch (e) {
      this.out.appendLine(`[bridge] connect pid=${entry.pid} failed: ${(e as Error).message}`)
      this.teardown('connect failed')
    }
  }

  private connectedPid?: number

  teardown(reason: string): void {
    if (this.state === 'off' && !this.client) return
    this.out.appendLine(`[bridge] off (${reason})`)
    this.client?.close()
    this.client = undefined
    this.connectedPid = undefined
    this.state = 'off'
    this._onState.fire({ state: 'off' })
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.disposables.forEach(d => d.dispose())
    this.teardown('dispose')
  }
}
