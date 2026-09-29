/**
 * End-to-end verification against a REAL dsh (acp-vscode profile, bridge on):
 * drives ChatViewProvider through the bug-1 and bug-2 user flows.
 *   node dist/verify-fixes.mjs
 */
import * as vscode from 'vscode'
import { AcpService } from '../src/acp/service.js'
import { ChatViewProvider } from '../src/chat/ChatViewProvider.js'
import { TranscriptStore } from '../src/chat/TranscriptStore.js'
import { ChangedFilesTracker } from '../src/chat/ChangedFilesTracker.js'
import { BridgeManager } from '../src/bridge/manager.js'
import { resolveLauncher } from '../src/launcher/detect.js'
import type { ToHost, ToWebview } from '../src/shared/messages.js'
import type { DshConfig } from '../src/launcher/types.js'

const lastOf = <T>(arr: T[], pred: (x: T) => boolean): T | undefined => { for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i]; return undefined }
class TestMemento {
  private map = new Map<string, unknown>()
  get<T>(key: string, def?: T): T { return (this.map.has(key) ? this.map.get(key) : def) as T }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.map.delete(key); else this.map.set(key, value) }
}
const noopDisposable = { dispose: (): void => {} }

// DSH_COMMAND lets this run against any dsh (repo checkout, global install…).
// The bridge legs (preset switch) need a bridge-equipped profile (acp-vscode).
const HOME = process.env.HOME!
const cfg: DshConfig = {
  runtime: 'auto',
  profile: process.env.DSH_PROFILE ?? 'acp-vscode',
  command: process.env.DSH_COMMAND ?? `node ${HOME}/deepseek-harness/apps/cli/lib/bin.js`,
  wslDistro: '', env: {},
}
const launcher = resolveLauncher('linux', cfg)
const out = vscode.window.createOutputChannel('verify')
const tmp = await import('node:fs/promises').then(m => m.mkdtemp('/tmp/dsh-verify-'))
const ctx = {
  globalState: new TestMemento(), workspaceState: new TestMemento(),
  extensionUri: vscode.Uri.file(process.cwd()), globalStorageUri: vscode.Uri.file(tmp), subscriptions: [],
} as unknown as vscode.ExtensionContext

const posted: ToWebview[] = []

let hostHandler: (m: ToHost) => void = () => {}
const view = {
  visible: true,
  webview: {
    options: {}, html: '', cspSource: 'mock',
    asWebviewUri: (u: vscode.Uri) => `mock:${u.fsPath}`,
    postMessage: (m: ToWebview) => { posted.push(m); return Promise.resolve(true) },
    onDidReceiveMessage: (fn: (m: ToHost) => void) => { hostHandler = fn; return noopDisposable },
  },
  onDidDispose: () => noopDisposable,
} as unknown as vscode.WebviewView

const service = new AcpService(() => launcher, out)
const bridge = new BridgeManager(() => cfg, () => launcher.paths, out)
bridge.start()
const provider = new ChatViewProvider(ctx, service, new TranscriptStore(ctx), new ChangedFilesTracker(() => launcher, out), bridge, () => launcher, out)
provider.resolveWebviewView(view)

const send = (m: ToHost): void => hostHandler(m)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const waitFor = async (pred: () => boolean, tag: string, ms = 120_000): Promise<void> => {
  const t0 = Date.now()
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${tag}`); await sleep(100) }
}
const lastModel = (): string | undefined => {
  const m = lastOf(posted, m => m.type === 'configOptions' || m.type === 'sessionStarted') as any
  return m?.configOptions?.find((o: any) => o.id === 'model')?.currentValue
}
const ok = (name: string, cond: boolean): void => { console.log(`${cond ? '✅' : '❌'} ${name}`); if (!cond) process.exitCode = 1 }

// ---- bug 1 flow: blank session → preset/model/effort → send ----
send({ type: 'ready' })
await waitFor(() => posted.some(m => m.type === 'sessionStarted'), 'kickoff')
const sid = provider.activeSessionId!
try { await waitFor(() => bridge.isOn, 'bridge', 60_000) } catch { /* no bridge in this profile */ }
if (bridge.isOn) {
  send({ type: 'selectPreset', presetId: 'standard' })
  await sleep(1200)
} else {
  console.log('… bridge not available, skipping the preset leg')
}
send({ type: 'selectConfig', configId: 'model', value: '["waliapi","k3"]' })
await waitFor(() => lastModel() === '["waliapi","k3"]', 'model rail k3')
await sleep(1200) // auto effort pin settles
send({ type: 'selectConfig', configId: 'reasoning_effort', value: 'high' })
await sleep(800)
send({ type: 'prompt', text: 'Reply with exactly: PONG' })
await waitFor(() => posted.some(m => m.type === 'promptSettled' || m.type === 'error'), 'prompt', 180_000)
ok('bug1: prompt went to the same session', provider.activeSessionId === sid)
ok('bug1: model did not revert to default', lastModel() === '["waliapi","k3"]')

// ---- bug 2 flow: switch to a session locked by another live dsh process ----
// Provide LOCKED_SESSION_ID (a session currently open in `dsh web`, say) to run it.
const LOCKED = process.env.LOCKED_SESSION_ID
if (LOCKED) {
  const before = posted.length
  send({ type: 'resumeSession', sessionId: LOCKED })
  await waitFor(() => posted.slice(before).some(m => m.type === 'error'), 'switch error')
  const err = (lastOf(posted.slice(before), m => m.type === 'error') as any)?.message ?? ''
  if (/cwd does not match/.test(err)) {
    console.log('… LOCKED_SESSION_ID belongs to another workspace, skipping the lock-message leg')
  } else {
    ok('bug2: friendly lock message', /占用/.test(err))
  }
  ok('bug2: current session kept', provider.activeSessionId === sid)
  const lastState = (lastOf(posted, m => m.type === 'connectionState') as any)?.state
  ok('bug2: connection not marked closed', lastState === 'ready')
  // and the chat still works afterwards
  const settledBefore2 = posted.filter(m => m.type === 'promptSettled').length
  send({ type: 'prompt', text: 'Reply with exactly: PONG' })
  await waitFor(() => posted.filter(m => m.type === 'promptSettled').length > settledBefore2, 'second prompt', 180_000)
  ok('bug2: prompting still works on the kept session', provider.activeSessionId === sid && service.isReady)
} else {
  console.log('… LOCKED_SESSION_ID not set, skipping the lock-contention leg')
}

// ---- bug 3 flow: new session inherits the remembered selection ----
send({ type: 'newSession' })
await waitFor(() => provider.activeSessionId !== undefined && provider.activeSessionId !== sid, 'new session')
await waitFor(() => lastModel() === '["waliapi","k3"]', 'remembered model applied')
const lastEffort = (): string | undefined => {
  const m = lastOf(posted, m => m.type === 'configOptions' || m.type === 'sessionStarted') as any
  return m?.configOptions?.find((o: any) => o.id === 'reasoning_effort')?.currentValue
}
await waitFor(() => lastEffort() === 'high', 'remembered effort applied')
ok('bug3: new session inherited k3 + high', lastModel() === '["waliapi","k3"]' && lastEffort() === 'high')

// ---- genuine connection death → reconnect recovers without a window reload ----
const sid2 = provider.activeSessionId!
service.reset() // simulate the dsh process dying
await sleep(300)
const deadState = (lastOf(posted, m => m.type === 'connectionState') as any)?.state
ok('death: indicator goes red', deadState === 'closed')
send({ type: 'reconnect' })
await waitFor(() => (lastOf(posted, m => m.type === 'connectionState') as any)?.state === 'ready', 'reconnect ready', 180_000)
ok('death: reconnect brings the connection back', service.isReady)
send({ type: 'prompt', text: 'Reply with exactly: PONG' })
const settledBefore = posted.filter(m => m.type === 'promptSettled').length
await waitFor(() => posted.filter(m => m.type === 'promptSettled').length > settledBefore, 'prompt after reconnect', 180_000)
ok('death: same session re-attached after reconnect', provider.activeSessionId === sid2)
ok('death: model survived the restart (logged route)', lastModel() === '["waliapi","k3"]')

// ---- web-built session: switching imports its transcript from the dsh log ----
// Provide WEB_SESSION_ID (a session created outside this client, e.g. by the
// Web UI, in this workspace) to run it.
const WEB = process.env.WEB_SESSION_ID
if (WEB) {
  posted.length = 0
  send({ type: 'resumeSession', sessionId: WEB })
  await waitFor(() => provider.activeSessionId === WEB, 'web session switch', 60_000)
  await waitFor(() => posted.some(m => m.type === 'transcript' && m.sessionId === WEB), 'web transcript posted', 60_000)
  const tr = lastOf(posted, m => m.type === 'transcript' && m.sessionId === WEB) as any
  ok('web: transcript rebuilt from the dsh log', (tr?.messages?.length ?? 0) > 0)
} else {
  console.log('… WEB_SESSION_ID not set, skipping the transcript-import leg')
}

bridge.dispose(); provider.dispose(); service.dispose()
console.log('done')
process.exit(process.exitCode ?? 0)
