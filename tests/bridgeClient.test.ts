import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { BridgeClient, BridgeError } from '../src/bridge/client.ts'

const CAPS = { workspaceGrouping: true, sessionTitle: true, sessionArchive: true, presets: true, permissions: true, eventPush: true }
const HANDSHAKE = { protocolVersion: 1, plugin: 'dsh-vscode-bridge', version: '0.1.0', pid: 1, startedAt: 0, capabilities: CAPS }

interface Mock { server: Server; port: number; sockets: Socket[]; close: () => void }

/** Minimal ndjson JSON-RPC mock: token check, handshake, then delegate to `route`. */
function mockBridge(token: string, route: (msg: { id: number; method: string; params: unknown }, sock: Socket) => void): Promise<Mock> {
  const sockets: Socket[] = []
  const server = createServer(sock => {
    sockets.push(sock)
    let buf = ''
    sock.on('data', d => {
      buf += String(d)
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (msg.token !== token) {
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'unauthorized' } }) + '\n')
        } else if (msg.method === 'bridge.handshake') {
          sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: HANDSHAKE }) + '\n')
        } else {
          route(msg, sock)
        }
      }
    })
  })
  return new Promise(res => server.listen(0, '127.0.0.1', () =>
    res({ server, sockets, port: (server.address() as { port: number }).port, close: () => { sockets.forEach(s => s.destroy()); server.close() } })))
}


test('handshake + request roundtrip', async () => {
  const m = await mockBridge('tk', (msg, sock) => {
    if (msg.method === 'session.list') sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessions: [] } }) + '\n')
  })
  const c = await BridgeClient.connect({ port: m.port, token: 'tk', pid: 1, protocolVersion: 1 })
  assert.equal(c.capabilities?.sessionTitle, true)
  assert.deepEqual(await c.request('session.list'), { sessions: [] })
  c.close(); m.close()
})

test('wrong token rejected (-32001)', async () => {
  const m = await mockBridge('tk', () => undefined)
  await assert.rejects(
    BridgeClient.connect({ port: m.port, token: 'WRONG', pid: 1, protocolVersion: 1 }),
    (e: unknown) => e instanceof BridgeError && e.rpcCode === -32001,
  )
  m.close()
})

test('upstream error code passthrough (data.code)', async () => {
  const m = await mockBridge('tk', (msg, sock) => {
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32009, message: 'locked', data: { code: 'agent-preset/locked' } } }) + '\n')
  })
  const c = await BridgeClient.connect({ port: m.port, token: 'tk', pid: 1, protocolVersion: 1 })
  await assert.rejects(c.request('preset.select', { sessionId: 's', presetId: 'x' }),
    (e: unknown) => e instanceof BridgeError && e.dataCode === 'agent-preset/locked' && e.rpcCode === -32009)
  c.close(); m.close()
})

test('server push: bridge.event dispatched to onEvent', async () => {
  let serverSock: Socket | undefined
  const m = await mockBridge('tk', (msg, sock) => {
    serverSock = sock
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { subscribed: true } }) + '\n')
  })
  const c = await BridgeClient.connect({ port: m.port, token: 'tk', pid: 1, protocolVersion: 1 })
  const got = new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('no event within 3s')), 3000)
    c.onEvent = e => { clearTimeout(t); assert.equal(e.event?.type, 'todo/write'); res() }
  })
  await c.request('session.subscribe', { sessionId: 's1' })
  serverSock!.write(JSON.stringify({ jsonrpc: '2.0', method: 'bridge.event', params: { kind: 'session/event', sessionId: 's1', event: { type: 'todo/write', data: { todos: [] } } } }) + '\n')
  await got
  c.close(); m.close()
})
