import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscode from 'vscode'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeManager } from '../src/bridge/manager.ts'
import { BridgeClient } from '../src/bridge/client.ts'
import type { DiscoveryEntry } from '../src/bridge/discovery.ts'

test('late close from a replaced bridge cannot tear down the new connection', async t => {
  function client(): BridgeClient {
    return { close() {}, onClose() {}, onEvent() {} } as unknown as BridgeClient
  }
  const first = client()
  const second = client()
  const clients = [first, second]
  t.mock.method(BridgeClient, 'connect', async () => clients.shift()!)
  const manager = new BridgeManager(
    () => ({ runtime: 'auto', command: 'dsh', profile: 'acp-vscode', wslDistro: '', env: {} }),
    () => ({ toDsh: async path => path }),
    { appendLine() {} } as unknown as vscode.OutputChannel,
  )
  t.after(() => manager.dispose())
  // Exercise the connection transition independently of topology/discovery IO.
  const connector = manager as unknown as { connectEntry(entry: DiscoveryEntry): Promise<void> }
  const entry = { port: 1234, token: 'test', directories: [], filePath: 'test.json' }
  await connector.connectEntry({ ...entry, pid: 1 })
  await connector.connectEntry({ ...entry, pid: 2 })
  first.onClose()
  assert.equal(manager.client, second)
  assert.equal(manager.isOn, true)
  second.onClose()
  assert.equal(manager.isOn, false)
})

test('reconnect tries stale-first discovery candidates until a handshake succeeds', { skip: process.platform === 'win32' }, async t => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-candidates-'))
  const discovery = join(home, 'vscode-bridge')
  mkdirSync(discovery)
  const entries = [
    { pid: 2, port: 7311, token: 'new-stale', startedAt: '2026-11-17T05:00:02.000Z', directories: [process.cwd()] },
    { pid: 1, port: 7310, token: 'working', startedAt: '2026-11-17T05:00:01.000Z', directories: [process.cwd()] },
  ]
  for (const entry of entries) writeFileSync(join(discovery, `${entry.pid}.json`), JSON.stringify(entry))
  const calls: number[] = []
  const working = { close() {}, onClose() {}, onEvent() {} } as unknown as BridgeClient
  t.mock.method(BridgeClient, 'connect', async (entry: DiscoveryEntry) => {
    calls.push(entry.pid)
    if (entry.pid === 2) throw new Error('stale socket')
    return working
  })
  const manager = new BridgeManager(
    () => ({ runtime: 'auto', command: 'dsh', profile: 'acp-vscode', wslDistro: '', env: { DSH_HOME: home } }),
    () => ({ toDsh: async path => path }),
    { appendLine() {} } as unknown as vscode.OutputChannel,
  )
  t.after(() => manager.dispose())
  await manager.reconnect()
  assert.deepEqual(calls, [2, 1])
  assert.equal(manager.client, working)
  assert.equal(manager.isOn, true)
})
