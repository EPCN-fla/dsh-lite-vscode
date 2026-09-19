import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractDiffPaths, parsePorcelainZ, isIgnoredPath } from '../src/shared/changes.ts'

test('extractDiffPaths: tool_call with diffs', () => {
  const u: any = { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'edit', content: [
    { type: 'diff', path: '/a/b.ts', oldText: 'x', newText: 'y' },
    { type: 'content', content: { type: 'text', text: 'edited' } },
    { type: 'diff', path: '/a/c.ts', oldText: '', newText: 'z' },
  ] }
  assert.deepEqual(extractDiffPaths(u), ['/a/b.ts', '/a/c.ts'])
})

test('extractDiffPaths: ignores non-tool updates', () => {
  assert.deepEqual(extractDiffPaths({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } as any), [])
  assert.deepEqual(extractDiffPaths({ sessionUpdate: 'tool_call_update', toolCallId: 't1' } as any), [])
})

test('parsePorcelainZ: rename consumes the orig-path field', () => {
  const z = ' M src/a.ts\0?? src/new.ts\0R  src/renamed.ts\0src/old.ts\0'
  assert.deepEqual(parsePorcelainZ(z), [
    { path: 'src/a.ts', created: false },
    { path: 'src/new.ts', created: true },
    { path: 'src/renamed.ts', created: false },
  ])
})

test('parsePorcelainZ: empty', () => {
  assert.deepEqual(parsePorcelainZ(''), [])
})

test('isIgnoredPath', () => {
  assert.ok(isIgnoredPath('/w/.git/config'))
  assert.ok(isIgnoredPath('C:\\w\\node_modules\\x\\y.js'))
  assert.ok(!isIgnoredPath('/w/src/a.ts'))
})
