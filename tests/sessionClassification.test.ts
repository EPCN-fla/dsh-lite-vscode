import { test } from 'node:test'
import assert from 'node:assert/strict'
import { directSubagents, matchesSubagentRequest, partitionSessions, type SessionRow } from '../src/shared/sessions.ts'

const rows: SessionRow[] = [
  { sessionId: 'root', live: true },
  { sessionId: 'ordinary-fork', parentSession: 'root', live: false },
  { sessionId: 'live-child', origin: 'subagent', parentSession: 'root', live: true },
  { sessionId: 'stored-child', origin: 'subagent', parentSession: 'root', live: false },
  { sessionId: 'nested-child', origin: 'subagent', parentSession: 'live-child', live: false },
  { sessionId: 'foreign-child', origin: 'subagent', parentSession: 'other-root', live: false },
]

test('origin separates root/ordinary forks from live and stored subagents', () => {
  const groups = partitionSessions(rows)
  assert.deepEqual(groups.sessions.map(row => row.sessionId), ['root', 'ordinary-fork'])
  assert.deepEqual(groups.subagents.map(row => row.sessionId), ['live-child', 'stored-child', 'nested-child', 'foreign-child'])
})

test('directSubagents counts only children of the current main session', () => {
  assert.deepEqual(directSubagents(rows, 'root').map(row => row.sessionId), ['live-child', 'stored-child'])
  assert.deepEqual(directSubagents(rows, 'live-child').map(row => row.sessionId), ['nested-child'])
  assert.deepEqual(directSubagents(rows, 'missing'), [])
  assert.deepEqual(directSubagents(rows, undefined), [])
})

test('subagent response identity rejects slow responses from another request or parent', () => {
  const current = { parentSessionId: 'root', sessionId: 'child', requestId: 2 }
  assert.ok(matchesSubagentRequest(current, { ...current }))
  assert.ok(!matchesSubagentRequest(current, { ...current, requestId: 1 }))
  assert.ok(!matchesSubagentRequest(current, { ...current, parentSessionId: 'other-root' }))
  assert.ok(!matchesSubagentRequest(current, { ...current, sessionId: 'other-child' }))
  assert.ok(!matchesSubagentRequest(undefined, current))
})
