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

test('tool_call stores raw input/output for the expanded card', () => {
  let s = reduce(withMessages(), {
    m: { type: 'update', sessionId: 'sess-1', update: { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'bash', status: 'in_progress', rawInput: { command: 'ls', description: '列目录' } } },
  })
  s = reduce(s, {
    m: { type: 'update', sessionId: 'sess-1', update: { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed', rawOutput: { exitCode: 0 } } },
  })
  const tool = s.messages.find(m => m.kind === 'tool')
  if (tool?.kind !== 'tool') assert.fail('tool message missing')
  assert.deepEqual(tool.input, { command: 'ls', description: '列目录' })
  assert.deepEqual(tool.output, { exitCode: 0 })
})

test('todo updates feed the pinned task card, not the message flow', () => {
  const before = withMessages().messages.length
  let s = reduce(withMessages(), { m: { type: 'todo', todos: [{ content: 'a', status: 'in_progress' }] } })
  assert.equal(s.messages.length, before)
  assert.deepEqual(s.todos, [{ content: 'a', status: 'in_progress' }])
  s = reduce(s, { m: { type: 'todo', todos: [{ content: 'a', status: 'completed' }] } })
  assert.deepEqual(s.todos, [{ content: 'a', status: 'completed' }])
  assert.equal(s.messages.length, before)
})

test('transcript lifts the last inline todo into the pinned card', () => {
  const messages = [
    { kind: 'user' as const, text: 'hi' },
    { kind: 'todo' as const, items: [{ content: 'a', status: 'completed' }] },
    { kind: 'assistant' as const, text: 'done' },
  ]
  const s = reduce(withMessages(), { m: { type: 'transcript', sessionId: 'sess-1', messages } })
  assert.deepEqual(s.todos, [{ content: 'a', status: 'completed' }])
  assert.equal(s.messages.length, 3)
})

test('session switch clears the task card', () => {
  let s = reduce(withMessages(), { m: { type: 'todo', todos: [{ content: 'a', status: 'completed' }] } })
  s = reduce(s, { m: { type: 'sessionStarted', sessionId: 'other', configOptions: [] } })
  assert.equal(s.todos, undefined)
})

test('usage messages update the status rail only for the active session', () => {
  let s = reduce(withMessages(), { m: { type: 'usage', sessionId: 'sess-1', text: '12% · 9.2k/128k' } })
  assert.equal(s.usageText, '12% · 9.2k/128k')
  s = reduce(s, { m: { type: 'usage', sessionId: 'other', text: '99%' } })
  assert.equal(s.usageText, '12% · 9.2k/128k')
  s = reduce(s, { m: { type: 'sessionStarted', sessionId: 'new', configOptions: [] } })
  assert.equal(s.usageText, undefined)
})

test('nativeCommands / skills flow into state and clear on session switch', () => {
  let s = reduce(withMessages(), { m: { type: 'nativeCommands', commands: [{ name: 'compact', description: '压缩' }] } })
  s = reduce(s, { m: { type: 'skills', skills: [{ name: 'dsh-benchmark-case' }] } })
  assert.equal(s.nativeCommands?.length, 1)
  assert.equal(s.skills?.[0].name, 'dsh-benchmark-case')
  s = reduce(s, { m: { type: 'sessionStarted', sessionId: 'other', configOptions: [] } })
  assert.equal(s.nativeCommands, undefined)
  assert.equal(s.skills, undefined)
})

test('commandResult appends a system message with a status glyph', () => {
  let s = reduce(withMessages(), { m: { type: 'commandResult', sessionId: 'sess-1', kind: 'success', text: 'Compacted 42 items.' } })
  let last = s.messages[s.messages.length - 1]
  assert.deepEqual(last, { kind: 'system', text: '✓ Compacted 42 items.' })
  s = reduce(s, { m: { type: 'commandResult', sessionId: 'sess-1', kind: 'error' } })
  last = s.messages[s.messages.length - 1]
  assert.deepEqual(last, { kind: 'system', text: '✖ Command failed.' })
  // Results for a session we switched away from are dropped.
  const before = s.messages.length
  s = reduce(s, { m: { type: 'commandResult', sessionId: 'stale', kind: 'success', text: 'late' } })
  assert.equal(s.messages.length, before)
})

test('commandRunning tracks the executing native command per session', () => {
  let s = reduce(withMessages(), { m: { type: 'commandRunning', sessionId: 'sess-1', line: '/compact', running: true } })
  assert.equal(s.commandRunning, '/compact')
  // Other sessions' indicators do not leak in.
  s = reduce(s, { m: { type: 'commandRunning', sessionId: 'other', line: '/plan', running: true } })
  assert.equal(s.commandRunning, '/compact')
  s = reduce(s, { m: { type: 'commandRunning', sessionId: 'sess-1', running: false } })
  assert.equal(s.commandRunning, undefined)
  s = reduce(s, { m: { type: 'commandRunning', sessionId: 'sess-1', line: '/plan', running: true } })
  s = reduce(s, { m: { type: 'sessionStarted', sessionId: 'next', configOptions: [] } })
  assert.equal(s.commandRunning, undefined)
})
