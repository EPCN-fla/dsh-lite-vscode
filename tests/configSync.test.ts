import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { BridgeClient, BridgeError } from '../src/bridge/client.ts'
import { ConfigSyncFlow, configSyncErrorText, type ConfigSyncSummary } from '../src/bridge/configSync.ts'

const preview: ConfigSyncSummary = {
  source: 'web', target: 'acp-vscode', revision: 'a'.repeat(64),
  providers: ['custom-provider'], presets: ['custom-preset'], skipped: ['provider:existing'],
  supportRows: ['agent-preset-registry'], changed: true, restartRequired: true,
}

function fixture(t: TestContext) {
  const calls: { method: string; params: unknown }[] = []
  const messages: { message: string; detail?: string }[] = []
  const choices: unknown[] = [{ models: true, presets: true }, { overwrite: false }]
  let confirm: string | undefined = 'Import'
  let result = preview
  let failure: Error | undefined
  const client = {
    capabilities: { configSync: true },
    async request(method: string, params: unknown) {
      calls.push({ method, params })
      if (method === 'config.preview') return result
      if (failure) throw failure
      return { ...result, backupPath: '/host/profile/cordis.patch.yml.bridge-backup-test' }
    },
  } as unknown as BridgeClient
  const bridge = { isOn: true, client: client as BridgeClient | undefined }
  t.mock.method(vscode.window, 'showQuickPick', async () => choices.shift())
  t.mock.method(vscode.window, 'showWarningMessage', async (message: string, options?: { detail?: string }) => {
    messages.push({ message, detail: options?.detail })
    return confirm
  })
  t.mock.method(vscode.window, 'showInformationMessage', async (message: string, options?: { detail?: string }) => {
    messages.push({ message, detail: options?.detail })
  })
  t.mock.method(vscode.window, 'showErrorMessage', async (message: string) => { messages.push({ message }) })
  let connections = 0
  const flow = new ConfigSyncFlow(bridge, async () => { connections++ })
  return {
    flow, bridge, calls, messages, choices,
    setConfirm: (value: string | undefined) => { confirm = value },
    setPreview: (value: ConfigSyncSummary) => { result = value },
    setFailure: (value: Error) => { failure = value },
    connections: () => connections,
  }
}

test('imports exactly the reviewed options and revision, displays host backup and restart guidance', async t => {
  const f = fixture(t)
  await f.flow.run()
  assert.deepEqual(f.calls, [
    { method: 'config.preview', params: { models: true, presets: true, overwrite: false } },
    { method: 'config.import', params: { models: true, presets: true, overwrite: false, revision: preview.revision } },
  ])
  for (const id of ['web', 'acp-vscode', 'custom-provider', 'custom-preset', 'agent-preset-registry', 'provider:existing']) {
    assert.ok(f.messages[0].detail?.includes(id), id)
  }
  assert.match(f.messages[1].detail!, /Backup on DSH host: \/host/)
  assert.match(f.messages[1].detail!, /Restart|restart/)
  assert.match(f.messages[1].detail!, /Reload Window/)
})

test('model-only overwrite uses identical options for preview and import', async t => {
  const f = fixture(t)
  f.choices.splice(0, 2, { models: true, presets: false }, { overwrite: true })
  await f.flow.run()
  assert.deepEqual(f.calls[1].params, { models: true, presets: false, overwrite: true, revision: preview.revision })
  assert.match(f.messages[0].detail!, /REPLACE complete/)
})

test('preset-only import is supported', async t => {
  const f = fixture(t)
  f.choices[0] = { models: false, presets: true }
  await f.flow.run()
  assert.deepEqual(f.calls[0].params, { models: false, presets: true, overwrite: false })
})

for (const stage of ['scope', 'policy', 'confirmation', 'unchanged'] as const) {
  test(`no writes on ${stage}`, async t => {
    const f = fixture(t)
    if (stage === 'scope') f.choices[0] = undefined
    if (stage === 'policy') f.choices[1] = undefined
    if (stage === 'confirmation') f.setConfirm(undefined)
    if (stage === 'unchanged') f.setPreview({ ...preview, changed: false, restartRequired: false })
    await f.flow.run()
    assert.ok(!f.calls.some(c => c.method === 'config.import'))
  })
}

for (const capability of [false, undefined]) {
  test(`missing capability (${capability}) never sends config RPCs`, async t => {
    const f = fixture(t)
    f.bridge.client!.capabilities!.configSync = capability
    await f.flow.run()
    assert.equal(f.calls.length, 0)
    assert.match(f.messages[0].message, /0.4.0/)
  })
}

test('disconnected bridge attempts connection and gives actionable guidance', async t => {
  const f = fixture(t)
  f.bridge.isOn = false
  f.bridge.client = undefined
  await f.flow.run()
  assert.equal(f.connections(), 1)
  assert.equal(f.calls.length, 0)
  assert.match(f.messages[0].message, /no bridge connected/)
})

test('stale revision is not automatically retried and does not leak errors', async t => {
  const f = fixture(t)
  f.setFailure(new BridgeError('SECRET YAML', -32009, 'config/stale-preview'))
  await f.flow.run()
  assert.equal(f.calls.length, 2)
  assert.match(f.messages.at(-1)!.message, /fresh preview/)
  assert.ok(!JSON.stringify(f.messages).includes('SECRET'))
})

test('connection replacement during confirmation cannot import into a different host', async t => {
  const f = fixture(t)
  t.mock.method(vscode.window, 'showWarningMessage', async () => {
    f.bridge.client = {} as BridgeClient
    return 'Import'
  })
  await f.flow.run()
  assert.deepEqual(f.calls.map(c => c.method), ['config.preview'])
})

test('overlapping invocations do not open another import, lock clears after cancellation', async t => {
  const f = fixture(t)
  f.setConfirm(undefined)
  await Promise.all([f.flow.run(), f.flow.run()])
  assert.equal(f.calls.length, 1)
  assert.ok(f.messages.some(m => m.message.includes('already open')))
  f.choices.push({ models: true, presets: true }, { overwrite: false })
  await f.flow.run()
  assert.equal(f.calls.length, 2)
})

test('all failures use safe diagnostics', () => {
  for (const code of ['config/import-busy', 'config/unavailable', 'config/same-profile', 'config/missing-package', 'config/shared-override', 'config/row-collision']) {
    assert.ok(!configSyncErrorText(new BridgeError('SECRET', -32009, code)).includes('SECRET'))
  }
  assert.ok(!configSyncErrorText(new Error('SECRET')).includes('SECRET'))
})

test('uncertain write outcome is not reported as a definite failure or retried', async t => {
  const f = fixture(t)
  f.setFailure(new BridgeError('SECRET', -32000, 'bridge/timeout'))
  await f.flow.run()
  assert.equal(f.calls.filter(c => c.method === 'config.import').length, 1)
  assert.match(f.messages.at(-1)!.message, /may have completed/)
  assert.ok(!f.messages.at(-1)!.message.includes('SECRET'))
})

test('connection replaced while preview is in flight is not shown as current', async t => {
  const f = fixture(t)
  t.mock.method(f.bridge.client!, 'request', async () => {
    f.bridge.client = {} as BridgeClient
    return preview
  })
  await f.flow.run()
  assert.ok(!f.messages.some(m => m.message === 'DSH: Import Web configuration?'))
})

test('interactive config RPCs have bounded deadlines', async t => {
  const f = fixture(t)
  const deadlines: (number | undefined)[] = []
  t.mock.method(f.bridge.client!, 'request', async (_method: string, _params: unknown, deadline?: number) => {
    deadlines.push(deadline)
    return preview
  })
  await f.flow.run()
  assert.deepEqual(deadlines, [30_000, 60_000])
})
