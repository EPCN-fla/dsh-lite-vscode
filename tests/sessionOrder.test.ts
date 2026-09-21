import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeSessions, ensureActive, shortSessionId, toRows, type SessionOrdering } from '../src/webview/sessionOrder.ts'

const mk = (id: string) => ({ sessionId: id })
const empty = (): SessionOrdering => ({ order: [], byId: new Map() })
const ids = (o: SessionOrdering, a?: string): string[] => toRows(o, a).map(r => r.sessionId + (r.active ? '*' : ''))

test('server order preserved (newest first)', () => {
  const o = mergeSessions(empty(), [mk('c'), mk('b'), mk('a')], undefined)
  assert.deepEqual(ids(o), ['c', 'b', 'a'])
})

test('active session keeps its slot when server omits it', () => {
  let o = mergeSessions(empty(), [mk('c'), mk('b'), mk('a')], undefined)
  o = ensureActive(o, 'b')
  assert.deepEqual(ids(o, 'b'), ['c', 'b*', 'a'])
  o = mergeSessions(o, [mk('c'), mk('a')], 'b')
  assert.deepEqual(ids(o, 'b'), ['c', 'b*', 'a'])
})

test('regression: render after server list + active keeps all rows', () => {
  let o = ensureActive(empty(), 'current')
  o = mergeSessions(o, Array.from({ length: 11 }, (_, i) => mk(`s${10 - i}`)), 'current')
  const rows = toRows(o, 'current')
  assert.equal(rows.length, 12)
  assert.equal(rows[0].sessionId, 'current') // new active session stays at head
})

test('brand-new session prepends; resumed sessions keep natural position', () => {
  let o = mergeSessions(ensureActive(empty(), 'current'), [mk('s1'), mk('s0')], 'current')
  o = ensureActive(o, 'new-one')
  assert.deepEqual(ids(o, 'new-one').slice(0, 3), ['new-one*', 'current', 's1'])
})

test('switching away returns session to natural server position', () => {
  let o = mergeSessions(ensureActive(empty(), 'n'), [mk('c'), mk('b')], 'n')
  o = mergeSessions(o, [mk('n'), mk('c'), mk('b')], 'c')
  assert.deepEqual(ids(o, 'c'), ['n', 'c*', 'b'])
})

test('shortSessionId strips the session- header from id fallbacks', () => {
  assert.equal(shortSessionId('session-ef01f12a-1234-5678-9abc-def012345678'), 'ef01f12a')
  assert.equal(shortSessionId('c0ac43f5-1234'), 'c0ac43f5')
  assert.equal(shortSessionId('session-'), 'session-') // degenerate id keeps the raw form
})
