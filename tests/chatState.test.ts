import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolDetail, initialState, reduce, type ChatState } from '../src/webview/state.ts'

const withMessages = (): ChatState => ({
  ...initialState,
  sessionId: 'sess-1',
  messages: [{ kind: 'user', text: 'hi' }, { kind: 'assistant', text: 'hello' }],
})

test('regression: selectConfig must NOT wipe messages', () => {
  const s = reduce(withMessages(), { m: { type: 'configOptions', configOptions: [] } })
  assert.equal(s.messages.length, 2)
})

test('sessionStarted without resumed resets messages (new session semantics)', () => {
  const s = reduce(withMessages(), { m: { type: 'sessionStarted', sessionId: 'x', configOptions: [] } })
  assert.equal(s.messages.length, 0)
  assert.equal(s.sessionId, 'x')
})

test('sessionStarted with resumed keeps messages', () => {
  const s = reduce(withMessages(), { m: { type: 'sessionStarted', sessionId: 'x', configOptions: [], resumed: true } })
  assert.equal(s.messages.length, 2)
})

test('formatToolDetail: pure XML-ish args become key/value rows', () => {
  const d = '<path>/mnt/d/x.png</path>\n<type>image</type>\n<content>\nimage/png, 218x20\n</content>'
  const r = formatToolDetail(d)
  assert.equal(r.kind, 'kv')
  if (r.kind === 'kv') {
    assert.deepEqual(r.rows[0], { k: 'path', v: '/mnt/d/x.png' })
    assert.deepEqual(r.rows[2], { k: 'content', v: 'image/png, 218x20' })
  }
})

test('formatToolDetail: prose stays raw', () => {
  assert.equal(formatToolDetail('**Planning** to run ls').kind, 'text')
  assert.equal(formatToolDetail('<path>/a</path> then some text').kind, 'text')
})
