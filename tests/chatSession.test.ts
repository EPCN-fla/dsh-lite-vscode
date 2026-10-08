/**
 * Regression tests for the session-lifecycle bugs fixed in ChatViewProvider:
 *  1. a session created while the client is still starting must not be
 *     re-created (losing model/effort picks) on the first prompt;
 *  2. a failed session switch (target locked by another dsh instance) must
 *     keep the current session and not misreport the connection as closed;
 *  3. the last-used model+effort is remembered and replayed onto new sessions.
 *
 * Runs headless: vscode is aliased to tests/mockVscode.ts at bundle time and
 * AcpService is faked — no real dsh process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { shownMessages } from './mockVscode.ts'
import { ChatViewProvider } from '../src/chat/ChatViewProvider.ts'
import type { AcpService } from '../src/acp/service.ts'
import type { BridgeManager } from '../src/bridge/manager.ts'
import type { ChangedFilesTracker } from '../src/chat/ChangedFilesTracker.ts'
import type { TranscriptStore } from '../src/chat/TranscriptStore.ts'
import type { ToHost, ToWebview } from '../src/shared/messages.ts'
import type { Launcher } from '../src/launcher/types.ts'

/** Test-local stand-ins so this file typechecks against the real vscode API
 *  while running against tests/mockVscode.ts (esbuild alias at bundle time). */
class TestMemento {
  private map = new Map<string, unknown>()
  get<T>(key: string, def?: T): T { return (this.map.has(key) ? this.map.get(key) : def) as T }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.map.delete(key); else this.map.set(key, value) }
}
const noopDisposable = { dispose: (): void => {} }

const LOCKED_ID = 'session-locked-by-web'
const DEFAULT_MODEL = '["deepseek-official","deepseek-v4-flash"]'
const OTHER_MODEL = '["waliapi","k3"]'

function defaultOptions(): any[] {
  return [
    {
      id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: DEFAULT_MODEL,
      options: [
        { group: 'deepseek-official', name: 'DeepSeek', options: [{ value: DEFAULT_MODEL, name: 'DeepSeek-V4-Flash' }] },
        { group: 'waliapi', name: 'WaLiAPI', options: [{ value: OTHER_MODEL, name: 'k3' }] },
      ],
    },
    {
      id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: '',
      options: [{ value: '', name: 'Provider default' }, { value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'max', name: 'Max' }],
    },
  ]
}

/** Fake AcpService mimicking the real one's generation semantics: the first
 *  newSession() completes the client start, bumping generation mid-call. */
class FakeAcpService {
  generation = 0
  mcpServers: unknown[] = []
  isReady = true
  imageCapable = false
  created = 0
  prompts: { sessionId: string; model?: string }[] = []
  closedIds: string[] = []
  sets: { sessionId: string; configId: string; value: string }[] = []
  private live = new Map<string, any[]>()
  private stored = new Map<string, any[]>() // persisted but not live
  private updateEmitter = new vscode.EventEmitter<unknown>()
  private stateEmitter = new vscode.EventEmitter<unknown>()
  readonly onUpdate = this.updateEmitter.event
  readonly onState = this.stateEmitter.event
  setPermissionResponder(): void {}

  async ensureClient(): Promise<unknown> { return {} }
  async newSession(): Promise<{ sessionId: string; configOptions: any[] }> {
    this.created++
    if (this.generation === 0) this.generation = 1 // first call completes startup
    const id = `session-fresh-${this.created}`
    const options = defaultOptions()
    this.live.set(id, options)
    return { sessionId: id, configOptions: options }
  }
  addStored(id: string): void { this.stored.set(id, defaultOptions()) }
  /** Simulate an agent restart: live sessions survive only on disk; the
   *  generation bumps like a real re-start. */
  simulateRestart(): void {
    for (const [id, options] of this.live) this.stored.set(id, options)
    this.live.clear()
    this.generation++
  }
  /** Simulate the server forgetting a live session without a connection drop
   *  (e.g. a plugin hot-reload disposed it). */
  dropLive(id: string): void {
    const options = this.live.get(id)
    if (options) { this.live.delete(id); this.stored.set(id, options) }
  }
  async resumeSession(id: string): Promise<{ configOptions: any[] }> {
    if (this.live.has(id)) throw new Error(`Invalid params: session is already active: ${id}`)
    if (id === LOCKED_ID) {
      throw Object.assign(new Error('Internal error'), { data: { details: `session "${id}" is already owned by an active write handle` } })
    }
    const options = this.stored.get(id)
    if (!options) throw new Error(`Invalid params: session is not resumable: ${id}`)
    this.stored.delete(id)
    this.live.set(id, options)
    return { configOptions: options }
  }
  async closeSession(id: string): Promise<void> {
    const options = this.live.get(id)
    if (options) { this.live.delete(id); this.stored.set(id, options) }
    this.closedIds.push(id)
  }
  async setConfigOption(id: string, configId: string, value: string): Promise<{ configOptions: any[] }> {
    const options = this.live.get(id)
    if (!options) throw new Error(`Invalid params: unknown session: ${id}`)
    this.sets.push({ sessionId: id, configId, value })
    const opt = options.find(o => o.id === configId)
    if (!opt) throw new Error(`unknown session config option: ${configId}`)
    if (configId === 'model' && !JSON.stringify(opt.options).includes(JSON.stringify(value))) throw new Error(`unknown model option: ${value}`)
    opt.currentValue = value
    if (configId === 'model') options.find(o => o.id === 'reasoning_effort')!.currentValue = '' // server resets effort on model switch
    return { configOptions: options }
  }
  async prompt(id: string): Promise<{ stopReason: string }> {
    const options = this.live.get(id)
    if (!options) throw new Error(`Invalid params: unknown session: ${id}`)
    this.prompts.push({ sessionId: id, model: options.find(o => o.id === 'model')?.currentValue })
    return { stopReason: 'end_turn' }
  }
  async cancel(): Promise<void> {}
  async listSessionsForWorkspace(): Promise<{ sessions: never[] }> { return { sessions: [] } }
  dispose(): void {}
}

function makeHarness(service: FakeAcpService, bridgeOverride?: Record<string, unknown>) {
  const posted: ToWebview[] = []
  let hostHandler: (m: ToHost) => void = () => undefined
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      asWebviewUri: (u: vscode.Uri) => `mock:${u.fsPath}`,
      cspSource: 'mock',
      postMessage: (m: ToWebview) => { posted.push(m); return Promise.resolve(true) },
      onDidReceiveMessage: (fn: (m: ToHost) => void) => { hostHandler = fn; return noopDisposable },
    },
    onDidDispose: () => noopDisposable,
  } as unknown as vscode.WebviewView

  const ctx = {
    globalState: new TestMemento(),
    workspaceState: new TestMemento(),
    extensionUri: vscode.Uri.file('/tmp'),
    globalStorageUri: vscode.Uri.file('/tmp/dsh-test-storage'),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext

  const out = { appendLine: () => {}, append: () => {}, show: () => {} } as unknown as vscode.OutputChannel
  const noopEmitter = new vscode.EventEmitter<never>()
  const bridge = { isOn: false, state: 'off', capabilities: undefined, client: undefined, onState: noopEmitter.event, onEvent: noopEmitter.event, ...bridgeOverride }
  const tracker = { startSession: async () => {}, ingestUpdate: async () => {}, onDidChange: noopEmitter.event, filesFor: () => [], promptStarted: () => {}, promptSettled: async () => {}, openDiff: async () => {} }
  const transcriptsDeleted: string[] = []
  const transcripts = { load: async () => undefined, save: async () => {}, delete: async (id: string) => { transcriptsDeleted.push(id) } }
  const launcher = { paths: { toDsh: async (p: string) => p, fromDsh: async (p: string) => p } } as unknown as Launcher

  const provider = new ChatViewProvider(
    ctx,
    service as unknown as AcpService,
    transcripts as unknown as TranscriptStore,
    tracker as unknown as ChangedFilesTracker,
    bridge as unknown as BridgeManager,
    () => launcher,
    out,
  )
  provider.resolveWebviewView(view)
  const send = (m: ToHost): void => hostHandler(m)
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const waitFor = async (pred: () => boolean, tag: string): Promise<void> => {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > 10_000) throw new Error(`timeout waiting for ${tag}`)
      await sleep(10)
    }
  }
  const configPosts = (): Extract<ToWebview, { type: 'configOptions' | 'sessionStarted' }>[] =>
    posted.filter((m): m is Extract<ToWebview, { type: 'configOptions' | 'sessionStarted' }> => m.type === 'configOptions' || m.type === 'sessionStarted')
  return { posted, send, waitFor, provider, ctx, configPosts, sleep, transcriptsDeleted }
}

test('bug 1: a session created during client startup is not recreated on the first prompt', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service)
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const started = h.posted.find(m => m.type === 'sessionStarted') as Extract<ToWebview, { type: 'sessionStarted' }>
  assert.equal(service.generation, 1, 'startup completed during the first session/new')

  h.send({ type: 'selectConfig', configId: 'model', value: OTHER_MODEL })
  await h.waitFor(() => (h.configPosts().at(-1)?.configOptions as any[]).find(o => o.id === 'model')?.currentValue === OTHER_MODEL, 'model applied')

  h.send({ type: 'prompt', text: 'hello' })
  await h.waitFor(() => h.posted.some(m => m.type === 'promptSettled'), 'promptSettled')

  assert.equal(service.created, 1, 'no replacement session was created')
  assert.equal(service.prompts.length, 1)
  assert.equal(service.prompts[0].sessionId, started.sessionId, 'prompt went to the same session')
  assert.equal(service.prompts[0].model, OTHER_MODEL, 'prompt used the selected model')
})

test('startup: agent readiness alone creates no session — the webview render gates the kickoff', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service)
  // Window-startup restore order: the view resolves (agent boots) and the
  // agent reports ready while the webview bundle is still loading.
  ;(service as unknown as { stateEmitter: vscode.EventEmitter<unknown> }).stateEmitter.fire({ state: 'ready' })
  await h.sleep(200)
  assert.equal(service.created, 0, 'no session before the webview rendered')
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  assert.equal(service.created, 1, 'the webview ready message drives the kickoff')
})

test('bug 2: switching to a session locked by another instance keeps the current session and the real connection state', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service)
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const current = h.provider.activeSessionId!

  h.send({ type: 'resumeSession', sessionId: LOCKED_ID })
  await h.waitFor(() => h.posted.some(m => m.type === 'error'), 'error posted')

  assert.equal(h.provider.activeSessionId, current, 'current session survived the failed switch')
  assert.ok(!service.closedIds.includes(current), 'current session was never closed')
  const err = h.posted.find(m => m.type === 'error') as Extract<ToWebview, { type: 'error' }>
  assert.match(err.message, /占用/, 'the user gets the lock-contention explanation')
  const lastState = h.posted.filter(m => m.type === 'connectionState').at(-1) as Extract<ToWebview, { type: 'connectionState' }>
  assert.equal(lastState.state, 'ready', 'a request-level failure does not masquerade as a dropped connection')
})

test('bug 2: switching sessions resumes first and closes the previous session only on success', async () => {
  const service = new FakeAcpService()
  service.addStored('session-stored-1')
  const h = makeHarness(service)
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const current = h.provider.activeSessionId!

  h.send({ type: 'resumeSession', sessionId: 'session-stored-1' })
  await h.waitFor(() => h.provider.activeSessionId === 'session-stored-1', 'switched')
  assert.ok(service.closedIds.includes(current), 'previous session closed after the switch')
})

test('bug 3: the last-used model+effort is remembered and replayed onto new sessions', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service)
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')

  h.send({ type: 'selectConfig', configId: 'model', value: OTHER_MODEL })
  await h.waitFor(() => service.sets.some(x => x.configId === 'model' && x.value === OTHER_MODEL), 'model set')
  h.send({ type: 'selectConfig', configId: 'reasoning_effort', value: 'max' })
  await h.waitFor(() => service.sets.some(x => x.configId === 'reasoning_effort' && x.value === 'max'), 'effort set')
  assert.deepEqual(h.ctx.globalState.get('dsh.lastModelSelection'), { model: OTHER_MODEL, effort: 'max' })

  // make the session "used", then open a fresh one
  h.send({ type: 'prompt', text: 'hello' })
  await h.waitFor(() => h.posted.some(m => m.type === 'promptSettled'), 'promptSettled')
  h.send({ type: 'newSession' })
  await h.waitFor(() => service.created === 2, 'second session created')
  const fresh = `session-fresh-2`
  await h.waitFor(() => h.provider.activeSessionId === fresh, 'fresh session active')
  await h.waitFor(
    () => service.sets.some(x => x.sessionId === fresh && x.configId === 'model' && x.value === OTHER_MODEL)
      && service.sets.some(x => x.sessionId === fresh && x.configId === 'reasoning_effort' && x.value === 'max'),
    'remembered selection replayed on the fresh session',
  )
})

test('bug 3: a stale remembered model is ignored gracefully (default kept)', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service)
  h.ctx.globalState.update('dsh.lastModelSelection', { model: '["gone","no-such-model"]', effort: 'max' })
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const fresh = h.provider.activeSessionId!
  // the bogus model is rejected; the remembered effort still lands
  await h.waitFor(() => service.sets.some(x => x.sessionId === fresh && x.configId === 'reasoning_effort' && x.value === 'max'), 'remembered effort applied')
  const opts = h.configPosts().at(-1)?.configOptions as any[]
  assert.equal(opts.find(o => o.id === 'model')?.currentValue, DEFAULT_MODEL, 'default model kept')
})

test('a session switch overtaking a re-attach never merges the two sessions', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service)
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const first = h.provider.activeSessionId!
  service.addStored('session-stored-2')

  // next prompt must re-attach; gate the resume so the user switch overtakes it
  service.simulateRestart()
  let releaseResume!: () => void
  const gate = new Promise<void>(r => { releaseResume = r })
  const origResume = service.resumeSession.bind(service)
  service.resumeSession = async (id: string) => {
    if (id === first) await gate
    return origResume(id)
  }

  h.send({ type: 'prompt', text: 'hello' })
  await h.sleep(50) // the re-attach of `first` is now parked inside the gate
  h.send({ type: 'resumeSession', sessionId: 'session-stored-2' })
  await h.sleep(50)
  releaseResume()

  await h.waitFor(() => h.posted.some(m => m.type === 'promptSettled'), 'promptSettled')
  assert.equal(h.provider.activeSessionId, 'session-stored-2', 'the switch won cleanly')
  const opts = h.provider.activeConfigOptions() as any[]
  assert.equal(opts.find(o => o.id === 'model')?.currentValue, DEFAULT_MODEL, 'no foreign configOptions leaked into the active session')
  assert.equal(service.prompts.at(-1)?.sessionId, 'session-stored-2', 'the prompt followed the current session')
})

test('a session the server forgot is re-attached on the next prompt instead of failing forever', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service)
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const sid = h.provider.activeSessionId!
  service.dropLive(sid) // same generation — no restart

  h.send({ type: 'prompt', text: 'hello' })
  await h.waitFor(() => h.posted.some(m => m.type === 'error'), 'first prompt errors')
  h.send({ type: 'prompt', text: 'hello again' })
  await h.waitFor(() => h.posted.some(m => m.type === 'promptSettled'), 'second prompt settles')
  assert.equal(service.prompts.at(-1)?.sessionId, sid, 'the same session resumed from persistence')
  assert.equal(h.provider.activeSessionId, sid)
})

/** Bridge fake with a scriptable request handler; preset.list/current answer a
 *  two-entry roster so the broken mark is observable in the posted presets. */
function bridgeWithPresets(selectError: () => Error) {
  return {
    isOn: true,
    capabilities: { presets: true },
    client: {
      request: async (method: string) => {
        if (method === 'preset.select') throw selectError()
        if (method === 'preset.list') return { presets: [{ id: 'standard' }, { id: 'fancy' }] }
        if (method === 'preset.current') return { preset: 'standard' }
        if (method === 'session.list') return { sessions: [] }
        if (method === 'workspace.list') return { archivedSessionIds: [] }
        return {}
      },
    },
  }
}

async function selectPresetAndWait(h: ReturnType<typeof makeHarness>, presetId: string): Promise<void> {
  h.send({ type: 'selectPreset', presetId })
  await h.waitFor(() => (h.ctx.globalState.get<string[]>('dsh.brokenPresets') ?? []).includes(presetId)
    || h.posted.some(m => m.type === 'error'), 'preset.select settled')
}

test('preset.select marks the preset broken on the 0.1.7 agent-preset/invalid wire code', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service, bridgeWithPresets(() =>
    Object.assign(new Error('mount failed'), { rpcCode: -32009, dataCode: 'agent-preset/invalid' })))
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'presets'), 'preset roster loaded')

  await selectPresetAndWait(h, 'fancy')

  assert.deepEqual(h.ctx.globalState.get('dsh.brokenPresets'), ['fancy'], 'the structured refusal is remembered')
  const last = h.posted.filter(m => m.type === 'presets').at(-1) as Extract<ToWebview, { type: 'presets' }>
  assert.equal(last.presets.find(p => p.id === 'fancy')?.broken, true, 'the option disables')
  assert.equal(last.presets.find(p => p.id === 'standard')?.broken, undefined, 'other presets stay enabled')
})

test('preset.select still marks the preset broken on the 0.1.5 "failed to mount" message', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service, bridgeWithPresets(() =>
    new Error('agent-presets: preset "cordis" failed to mount: client plane unavailable')))
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'presets'), 'preset roster loaded')

  await selectPresetAndWait(h, 'fancy')

  assert.deepEqual(h.ctx.globalState.get('dsh.brokenPresets'), ['fancy'], 'the legacy message keeps working for 0.1.5 hosts')
})

test('preset.select does not mark the preset on an unrelated failure', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service, bridgeWithPresets(() => new Error('connection reset')))
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'presets'), 'preset roster loaded')

  await selectPresetAndWait(h, 'fancy')

  assert.deepEqual(h.ctx.globalState.get('dsh.brokenPresets'), undefined, 'a transport error is not a mount refusal')
  const last = h.posted.filter(m => m.type === 'presets').at(-1) as Extract<ToWebview, { type: 'presets' }>
  assert.equal(last.presets.find(p => p.id === 'fancy')?.broken, undefined, 'the option stays enabled')
})

test('session.delete refused with session/active keeps local state and prompts to stop first', async () => {
  const service = new FakeAcpService()
  const h = makeHarness(service, {
    isOn: true,
    client: {
      request: async (method: string) => {
        // DSH 0.1.7 WorkspaceActiveSessionError, mapped by the bridge (>= 0.2.0).
        if (method === 'session.delete') throw Object.assign(new Error(`cannot archive session: the session is active (turn)`), { rpcCode: -32009, dataCode: 'session/active' })
        if (method === 'session.list') return { sessions: [] }
        if (method === 'workspace.list') return { archivedSessionIds: [] }
        return {}
      },
    },
  })
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const sid = h.provider.activeSessionId!

  h.send({ type: 'deleteSession', sessionId: sid })
  await h.waitFor(() => shownMessages.some(m => m.kind === 'warning' && m.message.includes('请先停止')), 'stop-first warning')

  assert.equal(h.provider.activeSessionId, sid, 'the session is still active locally')
  assert.ok(!service.closedIds.includes(sid), 'the live session was not closed')
  assert.deepEqual(h.transcriptsDeleted, [], 'transcripts kept')
  assert.ok(!(h.ctx.globalState.get<string[]>('dsh.archivedSessionIds') ?? []).includes(sid), 'not archived locally')
})

test('session.delete archives on the host before tearing down the local session', async () => {
  const service = new FakeAcpService()
  const calls: string[] = []
  const h = makeHarness(service, {
    isOn: true,
    client: {
      request: async (method: string) => {
        if (method === 'session.delete') { calls.push('session.delete'); return { archived: true } }
        if (method === 'session.list') return { sessions: [] }
        if (method === 'workspace.list') return { archivedSessionIds: [] }
        return {}
      },
    },
  })
  const origClose = service.closeSession.bind(service)
  service.closeSession = async (id: string) => { calls.push('closeSession'); return origClose(id) }
  h.send({ type: 'ready' })
  await h.waitFor(() => h.posted.some(m => m.type === 'sessionStarted'), 'sessionStarted')
  const sid = h.provider.activeSessionId!
  // Wait out the kickoff selection replay (its effort pin): deleting mid-replay
  // hits ensureSession's "switched away mid-replay" continue and spawns a
  // replacement session — the race this assertion ordering must not measure.
  await h.waitFor(() => service.sets.some(x => x.sessionId === sid && x.configId === 'reasoning_effort'), 'effort pin settled')

  // The flow physically deletes $DSH_HOME/sessions data — sandbox it.
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const sessionsBefore = h.posted.filter(m => m.type === 'sessions').length
  try {
    h.send({ type: 'deleteSession', sessionId: sid })
    // The trailing pushSessions runs after the physical delete: when the new
    // sessions post lands, the whole flow has settled.
    await h.waitFor(() => h.posted.filter(m => m.type === 'sessions').length > sessionsBefore, 'sessions refreshed')
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
  }

  assert.deepEqual(calls, ['session.delete', 'closeSession'], 'host archive precedes local teardown')
  assert.equal(h.provider.activeSessionId, undefined, 'the session is gone locally')
  assert.ok(h.transcriptsDeleted.includes(sid), 'transcripts deleted')
  assert.ok((h.ctx.globalState.get<string[]>('dsh.archivedSessionIds') ?? []).includes(sid), 'archived marker recorded')
})
