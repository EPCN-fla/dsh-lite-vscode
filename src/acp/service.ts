/**
 * AcpService: owns the dsh ACP connection shared by all extension surfaces
 * (chat view, sessions view, future chat participant). vscode-aware but UI-free:
 * permission brokering is delegated to a responder set by the UI layer.
 */
import * as vscode from 'vscode'
import type {
  ContentBlock, ListSessionsResponse, NewSessionResponse, RequestPermissionRequest,
  RequestPermissionResponse, ResumeSessionResponse, SessionConfigOption,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { AcpClient } from './client.js'
import type { Launcher } from '../launcher/types.js'
import type { McpServer } from '@agentclientprotocol/sdk'

export type ConnectionState = 'starting' | 'ready' | 'closed'

export class AcpService implements vscode.Disposable {
  private client?: AcpClient
  private starting?: Promise<AcpClient>
  /** Increments on every successful (re)start; sessions pin the generation they belong to. */
  generation = 0
  /** MCP servers mounted on every new session (from dsh.mcpServers). */
  mcpServers: McpServer[] = []
  private permissionResponder?: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>

  private readonly _onUpdate = new vscode.EventEmitter<Parameters<NonNullable<Parameters<typeof AcpClient.start>[1]>['onUpdate']>[0]>()
  readonly onUpdate = this._onUpdate.event
  private readonly _onState = new vscode.EventEmitter<{ state: ConnectionState; detail?: string }>()
  readonly onState = this._onState.event

  constructor(
    private getLauncher: () => Launcher,
    private out: vscode.OutputChannel,
  ) {}

  get isReady(): boolean { return !!this.client && !this.client.isClosed }

  /** UI layer installs the permission broker (webview card). */
  setPermissionResponder(fn: typeof this.permissionResponder): void { this.permissionResponder = fn }

  async ensureClient(): Promise<AcpClient> {
    if (this.client && !this.client.isClosed) return this.client
    this.starting ??= this.start()
    try { this.client = await this.starting; return this.client }
    finally { this.starting = undefined }
  }

  private async start(): Promise<AcpClient> {
    const launcher = this.getLauncher()
    this._onState.fire({ state: 'starting' })
    const vscodeCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()
    const spec = await launcher.buildLaunchSpec(vscodeCwd)
    this.out.appendLine(`[dsh] topology: ${launcher.label}`)
    this.out.appendLine(`[dsh] spawn: ${spec.command} ${spec.args.map(a => (a.length > 100 ? a.slice(0, 100) + '…' : a)).join(' ')}`)
    const client = await AcpClient.start(spec, {
      onUpdate: n => this._onUpdate.fire(n),
      onPermission: r => this.permissionResponder
        ? this.permissionResponder(r)
        : Promise.resolve({ outcome: { outcome: 'cancelled' } }),
      onLog: l => this.out.append(l),
      onExit: i => {
        this.out.appendLine(`[dsh] exited code=${i.code} signal=${i.signal}`)
        if (i.stderrTail.trim()) this.out.appendLine(i.stderrTail.slice(-600))
        this.client = undefined
        this._onState.fire({ state: 'closed', detail: `exit ${i.code ?? i.signal}` })
      },
    })
    this.out.appendLine(`[dsh] connected: ${client.agentInfo?.name} ${client.agentInfo?.version}`)
    this.generation++
    this._onState.fire({ state: 'ready' })
    return client
  }

  get imageCapable(): boolean {
    return this.client?.agentCapabilities?.promptCapabilities?.image === true
  }

  private workspaceDshCwd(): string | undefined {
    // NOTE: caller must translate via launcher.paths when cross-side; this is the VS Code-side path.
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  async newSession(): Promise<NewSessionResponse> {
    const client = await this.ensureClient()
    const cwd = this.workspaceDshCwd()
    if (!cwd) throw new Error('Open a workspace folder first — dsh needs an absolute workspace cwd.')
    return client.newSession(await this.getLauncher().paths.toDsh(cwd), this.mcpServers)
  }

  async listSessionsForWorkspace(): Promise<ListSessionsResponse> {
    const client = await this.ensureClient()
    const cwd = this.workspaceDshCwd()
    return client.listSessions(cwd ? await this.getLauncher().paths.toDsh(cwd) : undefined)
  }

  async resumeSession(sessionId: string): Promise<ResumeSessionResponse> {
    // ACP requires cwd on resume; dsh validates it matches the session's persisted cwd,
    // so always pass the current workspace (the sessions view is cwd-filtered).
    const cwd = this.workspaceDshCwd()
    if (!cwd) throw new Error('Open a workspace folder first — dsh needs an absolute workspace cwd.')
    return (await this.ensureClient()).resumeSession(sessionId, await this.getLauncher().paths.toDsh(cwd))
  }

  async closeSession(sessionId: string): Promise<void> {
    if (this.client && !this.client.isClosed) await this.client.closeSession(sessionId)
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<SetSessionConfigOptionResponse> {
    return (await this.ensureClient()).setConfigOption(sessionId, configId, value)
  }

  async prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: string }> {
    return (await this.ensureClient()).prompt(sessionId, blocks)
  }

  async cancel(sessionId: string): Promise<void> {
    if (this.client && !this.client.isClosed) await this.client.cancel(sessionId)
  }

  reset(): void {
    this.client?.dispose()
    this.client = undefined
    this._onState.fire({ state: 'closed' })
  }

  dispose(): void { this.reset() }
}

export type { SessionConfigOption }
