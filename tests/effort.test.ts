import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseEffort, collectEffortDefaults, effortOptionsWithoutDefault, modelIdOf } from '../src/shared/model.ts'

const opts = [{ value: '' }, { value: 'low' }, { value: 'high' }, { value: 'max' }]

test('provider-default row filtered out', () => {
  assert.deepEqual(effortOptionsWithoutDefault(opts).map(o => o.value), ['low', 'high', 'max'])
})

test('chooseEffort prefers the configured defaultEffort', () => {
  assert.equal(chooseEffort(opts, 'high'), 'high')
})

test('chooseEffort falls back to the highest level', () => {
  assert.equal(chooseEffort(opts), 'max')
  assert.equal(chooseEffort(opts, 'nonexistent'), 'max') // unknown configured value → highest
  assert.equal(chooseEffort([{ value: '' }]), undefined) // nothing but default → leave as-is
})

test('chooseEffort ranks unknown ids by list order', () => {
  assert.equal(chooseEffort([{ value: '' }, { value: 'a' }, { value: 'b' }]), 'b')
})

test('modelIdOf parses ACP route values', () => {
  assert.equal(modelIdOf('["waliapi","k3-256k"]'), 'k3-256k')
  assert.equal(modelIdOf('nope'), undefined)
  assert.equal(modelIdOf('[]'), undefined)
})

test('collectEffortDefaults reads the legacy settings.yaml map shape', () => {
  const settings = {
    'llm-pi-ai': { providers: { waliapi: { models: [{ id: 'k3', defaultEffort: 'max' }, { id: 'k3-256k', defaultEffort: 'high' }] } } },
    'agent-presets': { default: 'minimal' }, // unrelated sections ignored
  }
  const map = collectEffortDefaults(settings)
  assert.equal(map.get('k3'), 'max')
  assert.equal(map.get('k3-256k'), 'high')
  assert.equal(map.size, 2)
})

test('collectEffortDefaults reads the per-profile patch-entry list shape (0.1.7)', () => {
  const patch = [
    { insert: [{ id: 'workspace', name: '@deepseek-ai/dsh-workspace' }] },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { waliapi: { models: [{ id: 'k3', defaultEffort: 'max' }] } } } },
    { id: 'permission', config: { presets: {} } },
  ]
  const map = collectEffortDefaults(patch)
  assert.equal(map.get('k3'), 'max')
  assert.equal(map.size, 1)
})

test('collectEffortDefaults tolerates junk and layers later documents over earlier ones', () => {
  const map = collectEffortDefaults(null)
  collectEffortDefaults({ providers: { p: { models: [{ id: 'a' }, { id: 'b', defaultEffort: 3 }, null] } } }, map)
  assert.equal(map.size, 0, 'non-string ids/efforts are skipped')
  collectEffortDefaults({ providers: { p: { models: [{ id: 'a', defaultEffort: 'low' }] } } }, map)
  collectEffortDefaults({ providers: { p: { models: [{ id: 'a', defaultEffort: 'high' }] } } }, map)
  assert.equal(map.get('a'), 'high', 'the profile patch overrides the legacy document')
})
