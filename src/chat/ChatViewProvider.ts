/**
 * Sidebar chat webview host: current session, prompt assembly with editor
 * context and images, permission brokering, transcript persistence, reconnect
 * recovery. ACP plumbing lives in AcpService.
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import type { SessionConfigOption, ContentBlock, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import type { AcpService } from '../acp/service.js'
import type { TranscriptStore } from './TranscriptStore.js'
import type { ChangedFilesTracker } from './ChangedFilesTracker.js'
import type { BridgeManager } from '../bridge/manager.js'
import type { BridgeEvent } from '../bridge/client.js'
import type { ContextChip, ToHost, ToWebview } from '../shared/messages.js'
import { autoAttachActiveFile, readConfig } from '../config.js'
import { formatUsage } from '../shared/usage.js'
import { chooseEffort, modelIdOf } from '../shared/model.js'
import { runTargetShell } from '../launcher/runTargetShell.js'
import { parse as parseYaml } from 'yaml'
import { deleteSessionData } from '../launcher/runTargetShell.js'

export interface ActiveSession { id: string; busy: boolean; configOptions: SessionConfigOption[]; generation: number }

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView
  private session?: ActiveSession
  private pendingPermissions = new Map<string, (r: { optionId: string | null }) => void>()
  private chips: ContextChip[] = []
  private pendingImages: { name: string; mimeType: string; data: string }[] = []
  private disposables: vscode.Disposable[] = []

  private readonly _onDidChangeSession = new vscode.EventEmitter<ActiveSession | undefined>()
  readonly onDidChangeSession = this._onDidChangeSession.event

  constructor(
    private ctx: vscode.ExtensionContext,
    private service: AcpService,
    private transcripts: TranscriptStore,
    private tracker: ChangedFilesTracker,
    private bridge: BridgeManager,
    private getLauncher: () => import('../launcher/types.js').Launcher,
    private out: vscode.OutputChannel,
  ) {
    this.failedPresets = new Set(this.ctx.globalState.get<string[]>('dsh.brokenPresets', []))
    service.setPermissionResponder(r => this.brokerPermission(r))
    this.disposables.push(service.onUpdate(n => {
      this.post({ type: 'update', sessionId: n.sessionId, update: n.update })
      void this.tracker.ingestUpdate(n.sessionId, n.update)
      if (n.sessionId === this.session?.id && n.update.sessionUpdate === 'usage_update') {
        this.usageText = formatUsage(n.update.used ?? 0, n.update.size ?? 0)
        this._onDidChangeSession.fire(this.session)
      }
    }))
    this.disposables.push(service.onState(e => {
      this.post({ type: 'connectionState', state: e.state, detail: e.detail })
      if (e.state === 'ready') {
        void this.pushSessions()
        // Startup kickoff restores the previous session or creates an eager one,
        // so rail pickers (model/effort/…) light up before the first prompt.
        if (this.view) void this.kickoffSession()
      }
    }))
    this.disposables.push(tracker.onDidChange(({ sessionId, files }) => {
      if (sessionId === this.session?.id) this.post({ type: 'changedFiles', sessionId, files })
    }))
    this.disposables.push(bridge.onState(({ state, capabilities }) => {
      this.post({ type: 'bridge', on: state === 'on', capabilities })
      if (state === 'on') {
        void this.pushSessions()
        void this.bridgeAttach()
      } else if (state === 'off') {
        void this.pushSessions()
      }
    }))
    this.disposables.push(bridge.onEvent(e => this.onBridgeEvent(e)))
  }

  /** After the bridge comes up (or the session changes): subscribe + load preset/permission. */
  private bridgeAttachedSession?: string
  private async bridgeAttach(): Promise<void> {
    if (!this.bridge.isOn || !this.session) return
    const c = this.bridge.client!
    const id = this.session.id
    if (this.bridgeAttachedSession !== id) {
      await c.request('session.unsubscribe').catch(() => undefined)
      await c.request('session.subscribe', { sessionId: id }).catch(() => undefined)
      this.bridgeAttachedSession = id
    }
    const caps = this.bridge.capabilities
    if (caps?.presets) {
      const [list, cur] = await Promise.all([
        c.request<{ presets: { id: string; name?: string; isDefault?: boolean; broken?: boolean }[] }>('preset.list').catch(() => undefined),
        c.request<{ preset: string | null }>('preset.current', { sessionId: id }).catch(() => undefined),
      ])
      if (list) { this.lastPresets = list.presets; this.post({ type: 'presets', presets: this.presetsWithMarks(), current: cur?.preset ?? null }) }
    }
    if (caps?.permissions) {
      const perm = await c.request<{ options: { value: string; name: string; description?: string }[]; current?: string }>('permission.get', { sessionId: id }).catch(() => undefined)
      if (perm) this.post({ type: 'permission', options: perm.options, current: perm.current })
    }
  }

  private onBridgeEvent(e: BridgeEvent): void {
    if (e.kind !== 'session/event' || !e.event) return
    const { type, data } = e.event
    if (e.sessionId !== this.session?.id && type !== 'session/title') return
    if (type === 'session/title') {
      void this.pushSessions()
    } else if (type === 'todo/write' && data && typeof data === 'object' && Array.isArray((data as { todos?: unknown }).todos)) {
      this.post({ type: 'todo', todos: (data as { todos: { content: string; status: string }[] }).todos })
    } else if (type === 'plan/mode' && data && typeof data === 'object') {
      this.post({ type: 'planMode', active: !!(data as { active?: boolean }).active })
    } else if (type === 'permission/preset' || type === 'sandbox/mode' || type === 'approval/policy') {
      const id = this.session?.id
      if (id && this.bridge.capabilities?.permissions) {
        void this.bridge.client!.request<{ options: { value: string; name: string }[]; current?: string }>('permission.get', { sessionId: id })
          .then(perm => this.post({ type: 'permission', options: perm.options, current: perm.current }))
          .catch(() => undefined)
      }
    } else if (type === 'agent-preset/selected') {
      const id = this.session?.id
      if (id && this.bridge.capabilities?.presets) {
        void this.bridge.client!.request<{ preset: string | null }>('preset.current', { sessionId: id })
          .then(cur => this.post({ type: 'presets', presets: this.presetsWithMarks(), current: cur.preset }))
          .catch(() => undefined)
      }
    }
  }

  private lastPresets: { id: string; name?: string; isDefault?: boolean; broken?: boolean | string }[] = []

  usageText?: string
  get activeSessionId(): string | undefined { return this.session?.id }
  activeConfigOptions(): SessionConfigOption[] | undefined { return this.session?.configOptions }

  // ---------- webview plumbing ----------

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] }
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((m: ToHost) => void this.onMessage(m))
    view.onDidDispose(() => { this.view = undefined })
    // Auto-start the agent as soon as the view is opened (Codex-style lazy boot).
    this.post({ type: 'connectionState', state: this.service.isReady ? 'ready' : 'starting' })
    this.service.ensureClient().catch(e => this.out.appendLine(`[dsh] auto-start failed: ${(e as Error).message}`))
  }

  private post(m: ToWebview): void { void this.view?.webview.postMessage(m) }

  private html(webview: vscode.Webview): string {
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'))
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.css'))
    const nonce = Math.random().toString(36).slice(2)
    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} data:">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><link rel="stylesheet" href="${css}"></head>
<body><div id="root"></div><script nonce="${nonce}" src="${js}"></script></body></html>`
  }

  /** Whether the current session has produced any prompt activity (empty sessions are reused). */
  private sessionHasActivity = false

  private setSession(s: ActiveSession | undefined, resumed = false): void {
    this.usageText = undefined
    this.sessionHasActivity = false
    this.session = s
    void this.ctx.workspaceState.update('dsh.activeSessionId', s?.id)
    this._onDidChangeSession.fire(s)
    if (s) this.post({ type: 'sessionStarted', sessionId: s.id, configOptions: s.configOptions, resumed })
    else this.post({ type: 'sessionEnded' })
  }

  private async ensureSession(): Promise<ActiveSession> {
    const gen = this.service.generation
    if (this.session) {
      if (this.session.generation === gen) return this.session
      // Agent restarted: in-process sessions died with it, but dsh persists them.
      // Re-attach via resume; fall back to a fresh session if persistence lacks it.
      try {
        const res = await this.service.resumeSession(this.session.id)
        this.session = { ...this.session, generation: gen, configOptions: res.configOptions ?? this.session.configOptions }
        this.out.appendLine(`[dsh] re-attached session ${this.session.id.slice(0, 8)} after restart`)
        this.post({ type: 'sessionStarted', sessionId: this.session.id, configOptions: this.session.configOptions, resumed: true })
        return this.session
      } catch (e) {
        this.out.appendLine(`[dsh] resume after restart failed (${(e as Error).message}); starting fresh`)
        this.setSession(undefined)
      }
    }
    const res = await this.service.newSession()
    this.setSession({ id: res.sessionId, busy: false, configOptions: res.configOptions ?? [], generation: gen })
    void this.tracker.startSession(res.sessionId)
    void this.bridgeAttach()
    void this.applyEffortDefault().catch(() => undefined)
    return this.session!
  }

  // ---------- message handling ----------

  private async onMessage(m: ToHost): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          const logoUri = this.view ? this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'dsh-logo.svg')).toString() : undefined
          this.post({ type: 'bootstrap', topology: this.getLauncher().label, workspaceName: vscode.workspace.workspaceFolders?.[0]?.name, logoUri })
          this.post({ type: 'connectionState', state: this.service.isReady ? 'ready' : 'closed' })
          this.post({ type: 'capabilities', image: this.service.imageCapable })
          this.post({ type: 'chips', chips: this.chips })
          this.postImageChips()
          if (this.session) {
            this.post({ type: 'sessionStarted', sessionId: this.session.id, configOptions: this.session.configOptions })
            void this.sendTranscript(this.session.id)
          }
          void this.pushSessions()
          // Restore the last active session across extension-host restarts
          // (Reload Window kills memory); creates one only when nothing resumes.
          void this.kickoffSession()
          return
        case 'prompt': return await this.onPrompt(m.text)
        case 'cancel': return this.session ? await this.service.cancel(this.session.id) : undefined
        case 'newSession': return await this.newSession()
        case 'selectConfig': return await this.onSelectConfig(m.configId, m.value)
        case 'permissionResponse': return this.onPermissionResponse(m.requestId, m.optionId)
        case 'persistTranscript': return await this.transcripts.save(m.sessionId, m.messages)
        case 'removeChip':
          this.chips = this.chips.filter(c => c.path !== m.path)
          this.post({ type: 'chips', chips: this.chips })
          return
        case 'addChip':
          if (!this.chips.some(c => c.path === m.path)) this.chips.push({ path: m.path, label: m.label })
          this.post({ type: 'chips', chips: this.chips })
          return
        case 'listSessions': return await this.pushSessions()
        case 'resumeSession': return await this.resume(m.sessionId)
        case 'reconnect': return await this.onReconnect()
        case 'renameSession': return await this.onRenameSession(m.sessionId, m.title)
        case 'deleteSession': return await this.onDeleteSession(m.sessionId)
        case 'selectPreset': return await this.onSelectPreset(m.presetId)
        case 'setPermission': return await this.onSetPermission(m.name)
        case 'pickImages': return await this.onPickImages()
        case 'pasteImage':
          this.pendingImages.push({ name: m.name, mimeType: m.mimeType, data: m.data })
          return this.postImageChips()
        case 'removeImage':
          this.pendingImages.splice(m.index, 1)
          return this.postImageChips()
        case 'fileSearch': return await this.onFileSearch(m.reqId, m.query)
        case 'openDiff': {
          const f = this.tracker.filesFor(this.session?.id ?? '').find(x => x.path === m.path)
          return await this.tracker.openDiff(f ?? { path: m.path, label: m.path, kind: 'modified' })
        }
      }
    } catch (e) {
      const msg = (e as Error).message
      this.post({ type: 'error', message: msg })
      this.post({ type: 'connectionState', state: 'closed', detail: msg.split('\n')[0] })
      if (this.session) { this.session.busy = false; this.post({ type: 'busy', busy: false }) }
      this.out.appendLine(`[dsh] error: ${msg}`)
      const choice = await vscode.window.showErrorMessage(`DSH: ${msg.split('\n')[0]}`, 'Open DSH Log')
      if (choice) this.out.show()
    }
  }

  // ---------- prompt ----------

  private async onPrompt(text: string): Promise<void> {
    const session = await this.ensureSession()
    this.sessionHasActivity = true
    if (session.busy) throw new Error('A prompt is already running — cancel it first.')
    const mapper = this.getLauncher().paths
    const blocks: ContentBlock[] = []
    const chipBlocks = async (chip: ContextChip): Promise<void> => {
      const dshPath = await mapper.toDsh(chip.path)
      blocks.push({ type: 'resource_link', uri: `file://${dshPath}`, name: chip.label })
      if (chip.selection) blocks.push({ type: 'text', text: `Relevant selection in ${chip.label}: lines ${chip.selection.startLine}-${chip.selection.endLine}.` })
    }
    for (const chip of this.chips) await chipBlocks(chip)
    if (autoAttachActiveFile()) {
      const chip = this.activeEditorChip()
      if (chip && !this.chips.some(c => c.path === chip.path)) await chipBlocks(chip)
    }
    if (this.pendingImages.length > 0) {
      if (this.service.imageCapable) {
        for (const img of this.pendingImages) blocks.push({ type: 'image', data: img.data, mimeType: img.mimeType })
      } else {
        this.post({ type: 'error', message: 'This dsh route does not accept image prompts (image capability is off).' })
      }
    }
    blocks.push({ type: 'text', text })
    this.chips = []
    this.pendingImages = []
    this.post({ type: 'chips', chips: [] })
    this.postImageChips()

    session.busy = true
    this.post({ type: 'busy', busy: true })
    this._onDidChangeSession.fire(session)
    this.tracker.promptStarted(session.id)
    try {
      const res = await this.service.prompt(session.id, blocks)
      this.post({ type: 'promptSettled', sessionId: session.id, stopReason: res.stopReason })
    } finally {
      session.busy = false
      this.post({ type: 'busy', busy: false })
      this._onDidChangeSession.fire(session)
      void this.pushSessions()
      void this.tracker.promptSettled(session.id)
    }
  }

  // ---------- sessions ----------

  /** Session switches race (auto-restore vs clicks): serialize them. */
  private switchLock: Promise<void> = Promise.resolve()
  private withSwitchLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.switchLock.then(fn, fn)
    this.switchLock = next.then(() => undefined, () => undefined)
    return next
  }

  /** Startup session kickoff: resume the previously active session when dsh still
   *  has it; only create a fresh session when there is nothing to resume. Without
   *  this every launch stacked another empty session (the eager-create path raced
   *  the webview restore path and usually won). Deduped while in flight; the
   *  switch lock inside resume() serializes against user-initiated switches. */
  private kickoff?: Promise<void>
  private kickoffSession(): Promise<void> {
    this.kickoff ??= (async () => {
      try {
        if (this.session) return
        const persisted = this.ctx.workspaceState.get<string>('dsh.activeSessionId')
        if (persisted) {
          try {
            await this.resume(persisted)
            return
          } catch (e) {
            this.out.appendLine(`[dsh] startup restore of ${persisted.slice(0, 8)} failed: ${(e as Error).message}`)
            void this.ctx.workspaceState.update('dsh.activeSessionId', undefined)
          }
        }
        if (!this.session) await this.ensureSession()
      } catch (e) {
        this.out.appendLine(`[dsh] startup session kickoff failed: ${(e as Error).message}`)
      } finally {
        this.kickoff = undefined
      }
    })()
    return this.kickoff
  }

  async newSession(): Promise<void> {
    return this.withSwitchLock(async () => {
      // Reuse an untouched session instead of stacking empty ones.
      if (this.session && !this.sessionHasActivity) {
        this.out.appendLine('[dsh] current session is empty — reusing it instead of creating another')
        return
      }
      if (this.session) await this.service.closeSession(this.session.id).catch(() => undefined)
      this.setSession(undefined)
      await this.ensureSession()
      void this.pushSessions()
    })
  }

  async resume(sessionId: string): Promise<void> {
    return this.withSwitchLock(async () => {
      if (this.session?.id === sessionId) return
      if (this.session) await this.service.closeSession(this.session.id).catch(() => undefined)
      try {
        const res = await this.service.resumeSession(sessionId)
        this.setSession({ id: sessionId, busy: false, configOptions: res.configOptions ?? [], generation: this.service.generation }, true)
      } catch (e) {
        // "already active" = an earlier switch on THIS connection owns it; adopt instead of erroring.
        if (!/already active/.test((e as Error).message)) throw e
        this.out.appendLine(`[dsh] resume hit already-active ${sessionId.slice(0, 8)}; adopting`)
        this.setSession({ id: sessionId, busy: false, configOptions: this.session?.configOptions ?? [], generation: this.service.generation }, true)
      }
      // Only a transcript with real activity makes the session "used"; a resumed
      // empty session stays eligible for the empty-session reuse in newSession().
      this.sessionHasActivity = ((await this.transcripts.load(sessionId)) ?? []).some(m => m.kind !== 'system')
      void this.bridgeAttach()
      await this.sendTranscript(sessionId)
      void this.pushSessions()
    })
  }

  /** Bridge path: native titles + archived-session filtering. */
  private async pushSessionsViaBridge(): Promise<boolean> {
    if (!this.bridge.isOn) return false
    const c = this.bridge.client!
    const wsCwd = vscode.workspace.workspaceFolders?.[0]
      ? await this.getLauncher().paths.toDsh(vscode.workspace.workspaceFolders![0].uri.fsPath)
      : undefined
    const [list, ws] = await Promise.all([
      c.request<{ sessions: { sessionId: string; title?: string | null; cwd?: string | null }[]; stored?: { sessionId: string; cwd?: string | null; title?: null }[] }>('session.list', { includeStored: true }),
      c.request<{ archivedSessionIds: string[] }>('workspace.list').catch(() => ({ archivedSessionIds: [] as string[] })),
    ])
    const archived = this.archivedLocal()
    for (const id of ws.archivedSessionIds) archived.add(id)
    const rows = [...list.sessions, ...(list.stored ?? [])]
      .filter(x => !archived.has(x.sessionId))
      .filter(x => !wsCwd || !x.cwd || x.cwd === wsCwd)
    // Stored rows are header-only; fold their titles in via session.get (bounded).
    const titled = await Promise.all(rows.map(async x => {
      if (x.title) return { sessionId: x.sessionId, cwd: x.cwd ?? undefined, title: x.title }
      const got = await c.request<{ title?: string | null }>('session.get', { sessionId: x.sessionId }).catch(() => undefined)
      return { sessionId: x.sessionId, cwd: x.cwd ?? undefined, title: got?.title ?? undefined }
    }))
    this.out.appendLine(`[dsh] sessions: ${titled.length} via bridge`)
    this.post({ type: 'sessions', sessions: titled })
    return true
  }

  /** Push the workspace-filtered session list.
   *  When the bridge profile is configured, the bridge is the single source:
   *  while it is connecting we stay silent (onState re-triggers) instead of
   *  flashing an ACP-sourced list that the bridge list then replaces. */
  async pushSessions(): Promise<void> {
    const bridgeExpected = readConfig().profile !== 'acp'
    if (bridgeExpected && this.bridge.state === 'connecting') return
    if (await this.pushSessionsViaBridge().catch(() => false)) return
    const toRow = (x: { sessionId: string; cwd: string; title?: string | null; updatedAt?: string | null }): { sessionId: string; cwd?: string; title?: string; updatedAt?: string } =>
      ({ sessionId: x.sessionId, cwd: x.cwd, title: x.title?.trim() || undefined, updatedAt: x.updatedAt ?? undefined })
    try {
      const res = await this.service.listSessionsForWorkspace()
      const archived = this.archivedLocal()
      const rows = res.sessions.filter(x => !archived.has(x.sessionId)).map(toRow)
      this.out.appendLine(`[dsh] sessions: ${rows.length} for workspace (acp)`)
      this.post({ type: 'sessions', sessions: rows })
    } catch (e) {
      // Never fall back to an unfiltered list: flashing foreign or archived
      // sessions for a beat is worse than showing none.
      this.out.appendLine(`[dsh] session/list failed: ${(e as Error).message}`)
    }
  }


  private async sendTranscript(sessionId: string): Promise<void> {
    const messages = await this.transcripts.load(sessionId)
    this.post(messages && messages.length > 0
      ? { type: 'transcript', sessionId, messages }
      : { type: 'transcript', sessionId, messages: [{ kind: 'system', text: 'Session resumed. History is not replayed by the agent (ACP automation surface); only the local cache is shown.' }] })
  }

  // ---------- bridge-backed session actions ----------

  private async onRenameSession(sessionId: string, title: string): Promise<void> {
    if (!this.bridge.isOn) throw new Error('Bridge plugin not connected — titles require dsh-vscode-bridge.')
    await this.bridge.client!.request('session.setTitle', { sessionId, title })
    await this.pushSessions()
  }

  private archivedLocal(): Set<string> {
    return new Set(this.ctx.globalState.get<string[]>('dsh.archivedSessionIds', []))
  }

  private async onDeleteSession(sessionId: string): Promise<void> {
    if (!this.bridge.isOn) throw new Error('Bridge plugin not connected — delete requires dsh-vscode-bridge.')
    const wasActive = this.session?.id === sessionId
    if (wasActive) {
      await this.service.closeSession(sessionId).catch(() => undefined)
      this.setSession(undefined)
    }
    await this.bridge.client!.request('session.delete', { sessionId })
    await this.transcripts.delete(sessionId)
    const archived = this.archivedLocal()
    archived.add(sessionId)
    await this.ctx.globalState.update('dsh.archivedSessionIds', [...archived])
    // Physical removal of the persisted session data (archive is registry-level only).
    try {
      const removed = await deleteSessionData(sessionId)
      if (removed.trim()) this.out.appendLine(`[dsh] deleted session data: ${removed.trim().split('\n').join(', ')}`)
    } catch (e) {
      this.out.appendLine(`[dsh] physical delete failed (archived anyway): ${(e as Error).message}`)
    }
    await this.pushSessions()
  }

  /** Presets that can never mount in a headless ACP host (need the Web/Desktop client plane). */
  private static readonly HOST_INCOMPATIBLE_PRESETS: Record<string, string> = {
    cordis: 'Requires the Web/Desktop client plane (Cordis plugin runtime); unavailable in headless ACP sessions.',
  }

  private failedPresets = new Set<string>()

  private presetsWithMarks(): typeof this.lastPresets {
    return this.lastPresets.map(pr => {
      const known = ChatViewProvider.HOST_INCOMPATIBLE_PRESETS[pr.id]
      if (known !== undefined) return { ...pr, broken: known }
      return this.failedPresets.has(pr.id) ? { ...pr, broken: true } : pr
    })
  }

  private async onSelectPreset(presetId: string): Promise<void> {
    if (!this.bridge.isOn || !this.session) return
    try {
      await this.bridge.client!.request('preset.select', { sessionId: this.session.id, presetId })
    } catch (e) {
      // Mount-time failures (e.g. client-plane-only presets) are not flagged by the
      // roster — mark locally so the option disables with the reason attached.
      if (/failed to mount/.test((e as Error).message)) {
        this.failedPresets.add(presetId)
        void this.ctx.globalState.update('dsh.brokenPresets', [...this.failedPresets])
        this.post({ type: 'presets', presets: this.presetsWithMarks() })
      }
      throw e
    }
    const cur = await this.bridge.client!.request<{ preset: string | null }>('preset.current', { sessionId: this.session.id })
    this.post({ type: 'presets', presets: this.presetsWithMarks(), current: cur.preset })
  }

  private async onSetPermission(name: string): Promise<void> {
    if (!this.bridge.isOn || !this.session) return
    const res = await this.bridge.client!.request<{ current: string }>('permission.set', { sessionId: this.session.id, name })
    const perm = await this.bridge.client!.request<{ options: { value: string; name: string; description?: string }[]; current?: string }>('permission.get', { sessionId: this.session.id })
    this.post({ type: 'permission', options: perm.options, current: res.current })
  }

  // ---------- reconnect & images ----------

  private async onReconnect(): Promise<void> {
    await this.service.ensureClient()
    this.post({ type: 'connectionState', state: 'ready' })
    this.post({ type: 'capabilities', image: this.service.imageCapable })
    if (this.session) {
      // Force the generation check inside ensureSession to re-attach.
      this.session = { ...this.session, generation: -1 }
      await this.ensureSession()
    }
    void this.pushSessions()
  }

  private async onPickImages(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
      openLabel: 'Attach image',
    })
    if (!uris) return
    for (const u of uris) {
      const data = await vscode.workspace.fs.readFile(u)
      this.pendingImages.push({
        name: u.path.split('/').pop() ?? 'image',
        mimeType: `image/${(u.path.split('.').pop() ?? 'png').replace('jpg', 'jpeg')}`,
        data: Buffer.from(data).toString('base64'),
      })
    }
    this.postImageChips()
  }

  private postImageChips(): void {
    this.post({ type: 'imageChips', images: this.pendingImages.map(i => ({ name: i.name, size: Math.round(i.data.length * 0.75) })) })
  }

  // ---------- reasoning effort default ----------

  private effortDefaults?: Map<string, string>

  /** model id → defaultEffort, from $DSH_HOME/settings.yaml (target side). */
  private async loadEffortDefaults(): Promise<Map<string, string>> {
    if (this.effortDefaults) return this.effortDefaults
    const map = new Map<string, string>()
    try {
      const r = await runTargetShell('cat "${DSH_HOME:-$HOME/.dsh}/settings.yaml" 2>/dev/null || true')
      const doc = parseYaml(r.stdout) as { [k: string]: { providers?: Record<string, { models?: { id?: string; defaultEffort?: string }[] }> } } | undefined
      for (const family of Object.values(doc ?? {})) {
        const providers = family?.providers
        if (!providers || typeof providers !== 'object') continue
        for (const p of Object.values(providers)) {
          for (const m of p?.models ?? []) {
            if (m?.id && typeof m.defaultEffort === 'string') map.set(m.id, m.defaultEffort)
          }
        }
      }
    } catch (e) {
      this.out.appendLine(`[dsh] effort defaults read failed: ${(e as Error).message}`)
    }
    this.effortDefaults = map
    return map
  }

  /** If the effort selector sits at provider-default, pin the configured/highest level. */
  private async applyEffortDefault(): Promise<void> {
    const session = this.session
    if (!session) return
    const effort = session.configOptions.find(o => o.id === 'reasoning_effort')
    const modelOpt = session.configOptions.find(o => o.category === 'model' || o.id === 'model')
    if (!effort || effort.type !== 'select' || effort.currentValue !== '') return
    const modelId = modelOpt && modelOpt.type === 'select' ? modelIdOf(modelOpt.currentValue) : undefined
    const configured = modelId ? (await this.loadEffortDefaults()).get(modelId) : undefined
    const desired = chooseEffort(effort.options as { value: string }[], configured)
    if (desired) {
      this.out.appendLine(`[dsh] pinning reasoning effort: ${desired}${configured ? ` (defaultEffort of ${modelId})` : ' (highest)'}`)
      await this.onSelectConfig('reasoning_effort', desired)
    }
  }

  // ---------- permissions ----------

  private async brokerPermission(r: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    // The webview card only works when the DSH view is on screen; otherwise
    // (e.g. a @dsh chat participant request) fall back to a native modal.
    if (!this.view?.visible) {
      const allow = r.options.find(o => o.kind === 'allow_once') ?? r.options[0]
      const reject = r.options.find(o => o.kind === 'reject_once')
      const pick = await vscode.window.showWarningMessage(
        `DSH wants to run: ${r.toolCall.title ?? 'tool'}`,
        { modal: true },
        allow?.name ?? 'Allow', reject?.name ?? 'Reject',
      )
      if (pick === (allow?.name ?? 'Allow')) return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      if (pick === (reject?.name ?? 'Reject') && reject) return { outcome: { outcome: 'selected', optionId: reject.optionId } }
      return { outcome: { outcome: 'cancelled' } }
    }
    const requestId = Math.random().toString(36).slice(2)
    this.post({
      type: 'permissionRequest', requestId,
      title: r.toolCall.title ?? 'Tool call',
      options: r.options.map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    })
    return new Promise(resolve => {
      this.pendingPermissions.set(requestId, ({ optionId }) => {
        this.post({ type: 'permissionResolved', requestId })
        resolve(optionId === null
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId } })
      })
    })
  }

  private onPermissionResponse(requestId: string, optionId: string | null): void {
    this.pendingPermissions.get(requestId)?.({ optionId })
    this.pendingPermissions.delete(requestId)
  }

  // ---------- file search (@-mentions) ----------

  private async onFileSearch(reqId: number, query: string): Promise<void> {
    const safe = query.replace(/[*?{}[\]\\]/g, '').trim()
    const EXCLUDES = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}'
    const seen = new Set<string>()
    const out: { path: string; label: string }[] = []
    const push = (u: vscode.Uri): void => {
      if (!seen.has(u.fsPath)) { seen.add(u.fsPath); out.push({ path: u.fsPath, label: vscode.workspace.asRelativePath(u) }) }
    }
    if (!safe) {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          const input = tab.input as { uri?: vscode.Uri } | undefined
          if (input?.uri?.scheme === 'file') push(input.uri)
        }
      }
      if (out.length < 20) {
        for (const u of await vscode.workspace.findFiles('**/*', EXCLUDES, 20 - out.length)) push(u)
      }
    } else {
      const uris = await vscode.workspace.findFiles(`**/*${safe}*`, EXCLUDES, 50)
      const lower = safe.toLowerCase()
      uris.sort((a, b) => {
        const an = a.path.split('/').pop()?.toLowerCase() ?? ''
        const bn = b.path.split('/').pop()?.toLowerCase() ?? ''
        return (an.startsWith(lower) ? 0 : 1) - (bn.startsWith(lower) ? 0 : 1) || an.localeCompare(bn)
      })
      for (const u of uris.slice(0, 20)) push(u)
    }
    this.post({ type: 'fileSearchResults', reqId, files: out })
  }

  // ---------- editor context ----------

  private activeEditorChip(): ContextChip | undefined {
    const ed = vscode.window.activeTextEditor
    if (!ed || ed.document.uri.scheme !== 'file') return undefined
    const sel = ed.selection
    return {
      path: ed.document.uri.fsPath,
      label: path.basename(ed.document.uri.fsPath),
      selection: sel && !sel.isEmpty ? { startLine: sel.start.line + 1, endLine: sel.end.line + 1 } : undefined,
    }
  }

  addActiveEditorToContext(): void {
    const chip = this.activeEditorChip()
    if (!chip) { void vscode.window.showInformationMessage('No active file to attach.'); return }
    if (!this.chips.some(c => c.path === chip.path)) this.chips.push(chip)
    this.post({ type: 'chips', chips: this.chips })
  }

  private async onSelectConfig(configId: string, value: string): Promise<void> {
    if (!this.session) return
    const res = await this.service.setConfigOption(this.session.id, configId, value)
    this.session.configOptions = res.configOptions ?? this.session.configOptions
    if (configId === 'model') void this.applyEffortDefault().catch(() => undefined)
    // Dedicated message: sessionStarted would wipe the transcript in the webview reducer.
    this.post({ type: 'configOptions', configOptions: this.session.configOptions })
    this._onDidChangeSession.fire(this.session)
  }

  reset(): void {
    for (const [, resolve] of this.pendingPermissions) resolve({ optionId: null })
    this.pendingPermissions.clear()
    this.setSession(undefined)
    this.post({ type: 'connectionState', state: 'closed' })
  }

  dispose(): void {
    this.reset()
    this.disposables.forEach(d => d.dispose())
    this._onDidChangeSession.dispose()
  }
}
