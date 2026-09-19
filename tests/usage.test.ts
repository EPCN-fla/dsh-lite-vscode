import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatUsage } from '../src/shared/usage.ts'

test('formatUsage compact forms', () => {
  assert.equal(formatUsage(9215, 1050000), '1% · 9.2k/1.05M')
  assert.equal(formatUsage(500, 0), '500 tok')
  assert.equal(formatUsage(999, 2000), '50% · 999/2k')
})
