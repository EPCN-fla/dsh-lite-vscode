import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDiscoveryDir, pickEntry, type DiscoveryEntry } from '../src/bridge/discovery.ts'

test('readDiscoveryDir: valid entries only, bad files skipped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-disc-'))
  try {
    assert.deepEqual(await readDiscoveryDir(join(dir, 'missing')), [])
    await writeFile(join(dir, '123.json'), JSON.stringify({ port: 7310, token: 'tk', pid: 123, startedAt: 10, directories: ['/ws/a'] }))
    await writeFile(join(dir, 'bad.json'), '{"port":1}')
    await writeFile(join(dir, 'legacy.json'), JSON.stringify({ port: 7311, token: 'x', pid: 9 })) // no directories
    await writeFile(join(dir, 'note.txt'), 'nope')
    const entries = await readDiscoveryDir(dir)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].pid, 123)
    assert.ok(entries[0].filePath.endsWith('123.json'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

const entry = (pid: number, startedAt: number, directories: string[]): DiscoveryEntry =>
  ({ pid, startedAt, directories, port: 7000 + pid, token: 't', filePath: `/x/${pid}.json` })

test('pickEntry: exact directory match, newest wins', () => {
  const entries = [entry(1, 100, ['/ws/a']), entry(2, 200, ['/ws/a', '/ws/b']), entry(3, 300, ['/ws/c'])]
  assert.equal(pickEntry(entries, '/ws/a', false)?.pid, 2)
  assert.equal(pickEntry(entries, '/ws/c', false)?.pid, 3)
  assert.equal(pickEntry(entries, '/ws/none', false), undefined)
})

test('pickEntry: trailing slashes normalized; windows case-insensitive', () => {
  const entries = [entry(1, 1, ['C:\\\\proj\\\\x'])]
  assert.equal(pickEntry(entries, 'c:\\\\proj\\\\x\\\\', true)?.pid, 1)
  assert.equal(pickEntry(entries, '/ws/a/', false), undefined) // absent
  const e2 = [entry(2, 1, ['/ws/a/'])]
  assert.equal(pickEntry(e2, '/ws/a', false)?.pid, 2)
})
