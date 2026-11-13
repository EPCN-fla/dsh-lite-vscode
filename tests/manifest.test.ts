import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('Remote-WSL never falls back to a locally installed UI extension', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { extensionKind?: string[] }
  assert.deepEqual(manifest.extensionKind, ['workspace'])
})
