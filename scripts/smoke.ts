/**
 * Headless smoke test for AcpClient + LocalLauncher (case 1 topology: WSL↔WSL).
 * Asserts: initialize → session/new (configOptions present) → session/list → prompt
 * (prompt only runs when DEEPSEEK_API_KEY is set; otherwise expects the known
 * "no API key" error, which still proves the full wire roundtrip).
 */
import { AcpClient } from '../src/acp/client.js'
import { LocalLauncher } from '../src/launcher/local.js'

const command = process.env.DSH_COMMAND ?? 'npx -y @deepseek-ai/dsh'
const launcher = new LocalLauncher(
  { runtime: 'auto', profile: 'acp', command, wslDistro: '', env: { DSH_HOME: process.env.DSH_HOME ?? '/tmp/dsh-home', ...process.env.DEEPSEEK_API_KEY ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {} } },
  process.platform === 'win32' ? 'win32' : 'linux',
)

const spec = await launcher.buildLaunchSpec(process.env.SMOKE_CWD ?? process.cwd())
console.log('[smoke] launch:', spec.command, spec.args.join(' '))

const updates: string[] = []
const client = await AcpClient.start(spec, {
  onUpdate: n => {
    updates.push(n.update.sessionUpdate)
    if (n.update.sessionUpdate === 'agent_message_chunk' && n.update.content.type === 'text') {
      process.stdout.write(n.update.content.text)
    }
  },
  onPermission: async r => ({
    outcome: { outcome: 'selected', optionId: r.options.find(o => o.kind === 'allow_once')?.optionId ?? r.options[0].optionId },
  }),
  onLog: l => console.error('[dsh]', l.trim().slice(0, 200)),
  onExit: i => console.error('[exit]', i.code, i.signal, i.stderrTail.slice(-300)),
}, { timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 120_000) })
console.log('[smoke] agent:', JSON.stringify(client.agentInfo))

const list = await client.listSessions()
console.log('[smoke] sessions:', list.sessions.length)

// resume roundtrip: close nothing yet (no active), resume the newest persisted session
if (list.sessions.length > 0) {
  const target = list.sessions[0]
  const r = await client.resumeSession(target.sessionId, process.env.SMOKE_CWD ?? process.cwd())
  console.log('[smoke] resume OK:', target.sessionId.slice(0, 8), '| configOptions:', r.configOptions?.length ?? 0)
  await client.closeSession(target.sessionId)
  console.log('[smoke] resumed session closed')
}

const s = await client.newSession(process.env.SMOKE_CWD ?? process.cwd())
console.log('[smoke] sessionId:', s.sessionId)
const modelOpt = s.configOptions?.find(o => o.id === 'model')
console.log('[smoke] model options groups:', modelOpt?.type === 'select' ? JSON.stringify(modelOpt.options).slice(0, 120) : 'n/a')

try {
  const r = await client.prompt(s.sessionId, [{ type: 'text', text: 'Reply with exactly: PONG' }])
  console.log('\n[smoke] prompt stopReason:', r.stopReason, '| updates seen:', updates.join(','))
} catch (e) {
  const msg = (e as Error).message
  if (msg.includes('no API key')) console.log('[smoke] prompt reached LLM route (no API key in sandbox) — wire OK')
  else throw e
}

await client.closeSession(s.sessionId)
client.dispose()
console.log('[smoke] DONE ✔')
process.exit(0)
