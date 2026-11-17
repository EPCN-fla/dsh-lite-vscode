import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { BridgeError } from '../src/bridge/client.ts'
import { ConfigSyncFlow, configSyncErrorText, validateProfileName, type ConfigSyncOptions, type ConfigSyncSummary } from '../src/bridge/configSync.ts'
import { ProfileImportError, type ConfigSyncTransport } from '../src/bridge/profileImport.ts'

const preview: ConfigSyncSummary = {
  source: 'web', target: 'acp-vscode', revision: 'a'.repeat(64),
  providers: ['custom-provider'], presets: ['custom-preset'], skipped: ['provider:existing'],
  supportRows: ['agent-preset-registry'], changed: true, restartRequired: true,
}

function fixture(t: TestContext) {
  const calls: { method: string; source?: string; target?: string; params: unknown }[] = []
  const messages: { message: string; detail?: string }[] = []
  const choices: unknown[] = [{ models: true, presets: true }, { overwrite: false }]
  let confirm: string | undefined = 'Import'
  let result = preview
  let failure: Error | undefined
  let failureStage: 'preview' | 'import' = 'import'
  let sourceInput: string | undefined = 'web'
  let sourceExists = true
  let beforePreviewReturn: (() => void) | undefined
  let probes = 0
  const transport: ConfigSyncTransport = {
    async probeSource(source) {
      probes++
      calls.push({ method: 'profile.probe', source, params: {} })
      return sourceExists
    },
    async preview(source, target, options) {
      calls.push({ method: 'config.preview', source, target, params: options })
      if (failure && failureStage === 'preview') throw failure
      beforePreviewReturn?.()
      return { ...result, source, target }
    },
    async import(source, target, options, revision) {
      calls.push({ method: 'config.import', source, target, params: { ...options, revision } })
      if (failure && failureStage === 'import') throw failure
      return { ...result, source, target, backupPath: '/host/profile/cordis.patch.yml.bridge-backup-test' }
    },
  }
  const client = { capabilities: { configSync: true as boolean | undefined } }
  const bridge = { isOn: true, client: client as unknown }
  t.mock.method(vscode.window, 'showInputBox', async () => sourceInput)
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
  const flow = new ConfigSyncFlow(bridge, async () => { connections++ }, transport)
  return {
    flow, bridge, calls, messages, choices,
    setConfirm: (value: string | undefined) => { confirm = value },
    setPreview: (value: ConfigSyncSummary) => { result = value },
    setFailure: (value: Error, stage: 'preview' | 'import' = 'import') => { failure = value; failureStage = stage },
    setSource: (value: string | undefined, exists = true) => { sourceInput = value; sourceExists = exists },
    setBeforePreviewReturn: (hook: () => void) => { beforePreviewReturn = hook },
    probes: () => probes,
    connections: () => connections,
  }
}

test('imports exactly the reviewed source/options/revision and displays backup and restart guidance', async t => {
  const f = fixture(t)
  await f.flow.run()
  assert.deepEqual(f.calls, [
    { method: 'profile.probe', source: 'web', params: {} },
    { method: 'config.preview', source: 'web', target: 'acp-vscode', params: { models: true, presets: true, overwrite: false } },
    { method: 'config.import', source: 'web', target: 'acp-vscode', params: { models: true, presets: true, overwrite: false, revision: preview.revision } },
  ])
  for (const id of ['web', 'acp-vscode', 'custom-provider', 'custom-preset', 'agent-preset-registry', 'provider:existing']) {
    assert.ok(f.messages[0].detail?.includes(id), id)
  }
  assert.match(f.messages[1].detail!, /Backup on DSH host: \/host/)
  assert.match(f.messages[1].detail!, /Restart|restart/)
  assert.match(f.messages[1].detail!, /Reload Window/)
})

test('custom source profile is probed first and used for both preview and import', async t => {
  const f = fixture(t)
  f.setSource('team-settings')
  await f.flow.run()
  assert.deepEqual(f.calls.map(c => [c.method, c.source]), [
    ['profile.probe', 'team-settings'], ['config.preview', 'team-settings'], ['config.import', 'team-settings'],
  ])
  assert.match(f.messages[0].detail!, /Source: team-settings/)
})

test('missing source stops before category selection or preview', async t => {
  const f = fixture(t)
  f.setSource('missing-profile', false)
  await f.flow.run()
  assert.equal(f.probes(), 1)
  assert.deepEqual(f.calls.map(c => c.method), ['profile.probe'])
  assert.match(f.messages[0].message, /does not exist/)
})

test('model-only overwrite uses identical options for preview and import', async t => {
  const f = fixture(t)
  f.choices.splice(0, 2, { models: true, presets: false }, { overwrite: true })
  await f.flow.run()
  assert.deepEqual(f.calls[2].params, { models: true, presets: false, overwrite: true, revision: preview.revision })
  assert.match(f.messages[0].detail!, /ADD new and REPLACE complete/)
})

test('preset-only import is supported', async t => {
  const f = fixture(t)
  f.choices[0] = { models: false, presets: true }
  await f.flow.run()
  assert.deepEqual(f.calls[1].params, { models: false, presets: true, overwrite: false })
})

for (const stage of ['source', 'scope', 'policy', 'confirmation', 'unchanged'] as const) {
  test(`no writes on ${stage}`, async t => {
    const f = fixture(t)
    if (stage === 'source') f.setSource(undefined)
    if (stage === 'scope') f.choices[0] = undefined
    if (stage === 'policy') f.choices[1] = undefined
    if (stage === 'confirmation') f.setConfirm(undefined)
    if (stage === 'unchanged') f.setPreview({ ...preview, changed: false, restartRequired: false })
    await f.flow.run()
    assert.ok(!f.calls.some(c => c.method === 'config.import'))
  })
}

for (const capability of [false, undefined]) {
  test(`missing capability (${capability}) never probes or sends config requests`, async t => {
    const f = fixture(t)
    ;(f.bridge.client as { capabilities: { configSync?: boolean } }).capabilities.configSync = capability
    await f.flow.run()
    assert.equal(f.calls.length, 0)
    assert.match(f.messages[0].message, /0.4.0/)
  })
}

test('post-install host import does not require a running bridge', async t => {
  const f = fixture(t)
  f.bridge.isOn = false
  f.bridge.client = undefined
  await f.flow.run({ requireBridge: false })
  assert.equal(f.connections(), 0)
  assert.deepEqual(f.calls.map(c => c.method), ['profile.probe', 'config.preview', 'config.import'])
})

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
  f.setFailure(new ProfileImportError('config/stale-preview'))
  await f.flow.run()
  assert.equal(f.calls.length, 3)
  assert.match(f.messages.at(-1)!.message, /fresh preview/)
})

test('missing package during preview never imports and lists only safe package names', async t => {
  const f = fixture(t)
  f.setFailure(new ProfileImportError('config/missing-package', ['example-provider']), 'preview')
  await f.flow.run()
  assert.deepEqual(f.calls.map(c => c.method), ['profile.probe', 'config.preview'])
  assert.match(f.messages.at(-1)!.message, /example-provider/)
  assert.ok(!f.messages.at(-1)!.message.includes('SECRET'))
})

test('connection replacement during confirmation cannot import into a different host', async t => {
  const f = fixture(t)
  t.mock.method(vscode.window, 'showWarningMessage', async () => {
    f.bridge.client = {}
    return 'Import'
  })
  await f.flow.run()
  assert.deepEqual(f.calls.map(c => c.method), ['profile.probe', 'config.preview'])
})

test('target profile replacement during confirmation cannot import', async t => {
  const f = fixture(t)
  t.mock.method(vscode.window, 'showWarningMessage', async () => {
    await vscode.workspace.getConfiguration('dsh').update('profile', 'another-target')
    return 'Import'
  })
  try { await f.flow.run() } finally { await vscode.workspace.getConfiguration('dsh').update('profile', 'acp-vscode') }
  assert.deepEqual(f.calls.map(c => c.method), ['profile.probe', 'config.preview'])
})

test('overlapping invocations do not open another import, lock clears after cancellation', async t => {
  const f = fixture(t)
  f.setConfirm(undefined)
  await Promise.all([f.flow.run(), f.flow.run()])
  assert.equal(f.calls.filter(c => c.method === 'config.preview').length, 1)
  assert.ok(f.messages.some(m => m.message.includes('already open')))
  f.choices.push({ models: true, presets: true }, { overwrite: false })
  await f.flow.run()
  assert.equal(f.calls.filter(c => c.method === 'config.preview').length, 2)
})

test('all failures use safe diagnostics', () => {
  for (const code of ['config/import-busy', 'config/unavailable', 'config/same-profile', 'config/missing-package', 'config/shared-override', 'config/row-collision']) {
    assert.ok(!configSyncErrorText(new BridgeError('SECRET', -32009, code)).includes('SECRET'))
    assert.ok(!configSyncErrorText(new ProfileImportError(code)).includes('SECRET'))
  }
  assert.ok(!configSyncErrorText(new Error('SECRET')).includes('SECRET'))
})


test('node discovery failure has an actionable diagnostic instead of generic host failure', () => {
  const text = configSyncErrorText(new ProfileImportError('config/node-unavailable'))
  assert.match(text, /Node.js was not found/)
  assert.match(text, /nvm\/volta\/mise\/asdf/)
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
  f.setBeforePreviewReturn(() => { f.bridge.client = {} })
  await f.flow.run()
  assert.deepEqual(f.calls.map(c => c.method), ['profile.probe', 'config.preview'])
  assert.ok(!f.messages.some(m => m.message === 'DSH: Import profile configuration?'))
})

test('profile name validation rejects paths and reserved directory names', () => {
  for (const valid of ['web', 'team-profile', 'profile.with.dots']) assert.equal(validateProfileName(valid), undefined)
  for (const invalid of ['', '.', '..', 'node_modules', '../web', 'a/b', 'a\\b']) assert.ok(validateProfileName(invalid), invalid)
})
