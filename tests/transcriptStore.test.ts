import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { TranscriptStore } from '../src/chat/TranscriptStore.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'transcript-store-'))
  const ctx = { globalStorageUri: vscode.Uri.file(root) } as vscode.ExtensionContext
  const store = new TranscriptStore(ctx)
  const file = join(root, 'sessions', 'session-a.json')
  return { store, file }
}

test('delete tombstones queued and late writes so a transcript cannot reappear', async () => {
  const { store, file } = fixture()
  const first = store.save('session-a', [{ kind: 'assistant', text: 'first' }])
  const late = store.save('session-a', [{ kind: 'assistant', text: 'late' }])
  const removed = store.delete('session-a')
  await Promise.all([first, late, removed])
  await store.save('session-a', [{ kind: 'assistant', text: 'resurrected' }])
  assert.equal(existsSync(file), false)
  assert.equal(await store.load('session-a'), undefined)
})

test('delete waits for an already running write before removing the file', async () => {
  const { store, file } = fixture()
  await store.save('session-a', [{ kind: 'assistant', text: 'persisted' }])
  assert.equal(existsSync(file), true)
  await store.delete('session-a')
  assert.equal(existsSync(file), false)
})
