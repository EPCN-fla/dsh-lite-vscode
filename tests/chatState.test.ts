import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatToolDetail, initialState, reduce, toolSubtitle, type ChatState } from '../src/webview/state.ts'

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

test('toolSubtitle prefers the model-written description (web-UI-style label)', () => {
  assert.equal(toolSubtitle({ command: 'grep -n x a.ts', description: '阅读焊接异常定位小节' }), '阅读焊接异常定位小节')
  assert.equal(toolSubtitle({ path: '/src/a.ts' }), '/src/a.ts')
  assert.equal(toolSubtitle({ command: 'ls -la\nmore' }), 'ls -la')
  assert.equal(toolSubtitle('not-an-object'), undefined)
  assert.equal(toolSubtitle({ timeout: 5 }), undefined)
  const long = 'x'.repeat(200)
  assert.equal(toolSubtitle({ description: long })?.length, 118) // 117 chars + ellipsis
})

test('tool_call update keeps the subtitle derived from raw input', () => {
  let s = reduce(withMessages(), {
    m: { type: 'update', sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'other', status: 'in_progress', rawInput: { command: 'ls', description: '列目录' } } },
  })
  s = reduce(s, {
    m: { type: 'update', sessionId: 'sess-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } },
  })
  const tool = s.messages.find(m => m.kind === 'tool')
  assert.equal(tool?.kind === 'tool' && tool.subtitle, '列目录')
  assert.equal(tool?.kind === 'tool' && tool.status, 'completed')
})
