import { test } from 'node:test'
import assert from 'node:assert/strict'
import type * as vscode from 'vscode'
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
