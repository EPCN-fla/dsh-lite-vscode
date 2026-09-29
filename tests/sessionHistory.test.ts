/** Transcript-rebuild tests: canonical dsh session-log JSONL → ChatMessage[],
 *  and the bridge exportZip → unzip → parse import path. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { zipSync, strToU8 } from 'fflate'
import { parseSessionLog, importDshTranscript } from '../src/chat/sessionHistory.ts'
import type { BridgeClient } from '../src/bridge/client.ts'

const FIXTURE = [
  // header line (no `type`): skipped
  JSON.stringify({ version: 3, id: 'session-x', createdAt: 1, inheritedEventCount: 0 }),
  // direct user prompt
  JSON.stringify({ seq: 1, type: 'user/message', data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好，帮我看下这个文件' }], source: { kind: 'user' } } }),
  // plugin-injected context: model-facing only, skipped
  JSON.stringify({ seq: 2, type: 'user/message', data: { id: 'm2', role: 'user', content: [{ type: 'text', text: '[model changed: …]' }], source: { kind: 'plugin', plugin: 'model-selection', form: 'notice', summary: 'x' } } }),
  // assistant reasoning + answer
  JSON.stringify({ seq: 3, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm3', role: 'assistant', content: [{ type: 'reasoning', text: '先想想' }, { type: 'text', text: '好的，看一下。' }], source: { kind: 'model' } } } }),
  // tool call + result
  JSON.stringify({ seq: 4, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'fs_read', arguments: '{"path":"/tmp/a.txt"}' } }),
  JSON.stringify({ seq: 5, type: 'tool/result', data: { turn: 1, step: 1, message: { id: 'm4', role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] }], source: { kind: 'tool' } } } }),
  // boundaries and unknown future events: skipped
  JSON.stringify({ seq: 6, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }),
  JSON.stringify({ seq: 7, type: 'todo/write', data: { todos: [{ content: 'x', status: 'completed' }] } }),
].join('\n')

test('parseSessionLog converts the durable log into display messages', () => {
  const msgs = parseSessionLog(FIXTURE)
  assert.deepEqual(msgs.map(m => m.kind), ['user', 'thought', 'assistant', 'tool'])
  assert.equal(msgs[0].kind === 'user' && msgs[0].text, '你好，帮我看下这个文件')
  assert.equal(msgs[1].kind === 'thought' && msgs[1].text, '先想想')
  assert.equal(msgs[2].kind === 'assistant' && msgs[2].text, '好的，看一下。')
  const tool = msgs[3]
  assert.ok(tool.kind === 'tool')
  assert.equal(tool.id, 'c1')
  assert.equal(tool.title, 'fs_read')
  assert.equal(tool.subtitle, '/tmp/a.txt')
  assert.equal(tool.status, 'completed')
  assert.equal(tool.detail, 'file body')
})

test('parseSessionLog keeps failed results and raw (non-JSON) arguments', () => {
  const jsonl = [
    JSON.stringify({ seq: 1, type: 'tool/call', data: { callId: 'c2', name: 'bash', arguments: 'not-json' } }),
    JSON.stringify({ seq: 2, type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'boom' }] }] } } }),
  ].join('\n')
  const [tool] = parseSessionLog(jsonl)
  assert.ok(tool.kind === 'tool')
  assert.equal(tool.status, 'failed')
  assert.equal(tool.input, 'not-json')
  assert.equal(tool.detail, 'boom')
})

async function makeZip(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp('/tmp/dsh-hist-')
  const path = `${dir}/export.zip`
  await writeFile(path, zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))))
  return path
}

function fakeBridge(path: string, bytes: number): BridgeClient {
  return { request: async () => ({ path, fileName: 'export.zip', bytes }) } as unknown as BridgeClient
}

test('importDshTranscript reads the root log out of the export archive', async () => {
  const path = await makeZip({ 'session.v3.jsonl': FIXTURE, 'media/img1.png': 'png-bytes' })
  const msgs = await importDshTranscript('session-x', fakeBridge(path, 1000), { toDsh: async p => p, fromDsh: async p => p }, readFile)
  assert.ok(msgs)
  assert.equal(msgs!.length, 4)
  assert.equal(msgs![0].kind, 'user')
})

test('importDshTranscript returns undefined without a root log or when oversized', async () => {
  const path = await makeZip({ 'subagents/abc/session.v3.jsonl': FIXTURE })
  assert.equal(await importDshTranscript('session-x', fakeBridge(path, 1000), { toDsh: async p => p, fromDsh: async p => p }, readFile), undefined)
  assert.equal(await importDshTranscript('session-x', fakeBridge(path, 64 * 1024 * 1024), { toDsh: async p => p, fromDsh: async p => p }, readFile), undefined)
})
