import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseEffort, effortOptionsWithoutDefault, modelIdOf } from '../src/shared/model.ts'

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
