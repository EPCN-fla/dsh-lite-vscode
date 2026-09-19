// ACP roundtrip spike: zero-dep ndjson JSON-RPC client over stdio
import { spawn } from 'node:child_process'

const DSH = process.env.DSH_CMD || 'node'
const DSH_ARGS = process.env.DSH_ARGS?.split(' ') || ['/home/fla1337/deepseek-harness/apps/cli/lib/bin.js', '--profile', 'acp']

const child = spawn(DSH, DSH_ARGS, {
  env: { ...process.env, DSH_HOME: '/tmp/dsh-home' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
child.stderr.on('data', d => console.error('[dsh:stderr]', String(d).slice(0, 500)))

let buf = ''
const pending = new Map()
let nextId = 0
child.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { console.error('[bad line]', line.slice(0, 200)); continue }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, method } = pending.get(msg.id); pending.delete(msg.id)
      console.error(`[resp:${method}]`, JSON.stringify(msg).slice(0, 800))
      resolve(msg)
    } else if (msg.method) {
      console.error(`[notify:${msg.method}]`, JSON.stringify(msg.params).slice(0, 300))
      // auto-answer permission requests if any
      if (msg.method === 'session/request_permission') {
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: msg.params?.options?.[0]?.id ?? 'allow' } } })
      }
    }
  }
})
function send(obj) { child.stdin.write(JSON.stringify(obj) + '\n') }
function request(method, params) {
  const id = nextId++
  send({ jsonrpc: '2.0', id, method, params })
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, method })
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(method + ' timeout')) } }, 30000)
  })
}

const t0 = Date.now()
try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'dsh-vscode-spike', version: '0.0.1' },
  })
  console.error(`== initialize OK (+${Date.now() - t0}ms)`)
  const list = await request('session/list', {})
  console.error('== session/list OK, count =', JSON.stringify(init.result ? undefined : 0) ?? '', JSON.stringify(list.result).slice(0, 300))
  const s = await request('session/new', { cwd: '/mnt/h/Projects/dsh-vscode', mcpServers: [] })
  console.error('== session/new OK, sessionId =', s.result?.sessionId)
  const p = await request('session/prompt', { sessionId: s.result.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: PONG' }] })
  console.error('== prompt settled:', JSON.stringify(p).slice(0, 400))
} catch (e) {
  console.error('SPIKE FAIL:', e.message)
} finally {
  child.kill()
  process.exit(0)
}
