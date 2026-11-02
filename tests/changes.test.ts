import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as vscode from 'vscode'
import { extractDiffPaths, parsePorcelainZ, isIgnoredPath } from '../src/shared/changes.ts'
import { ChangedFilesTracker } from '../src/chat/ChangedFilesTracker.ts'
import type { Launcher } from '../src/launcher/types.ts'
import type { SessionUpdate } from '@agentclientprotocol/sdk'

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

test('isIgnoredPath: complete segments, suffixes, and lookalikes', () => {
  for (const p of [
    '/w/.git/config', '.git/config', '/w/.git', '.git',
    'C:\\w\\node_modules\\x\\y.js', 'node_modules/x.js',
    '/w/docs/debug.md.git', 'scratch.git',
  ]) assert.ok(isIgnoredPath(p), p)
  for (const p of [
    '/w/src/a.ts', '/w/.gitignore', '/w/.gitattributes',
    '/w/debug.md.gitignore', '/w/distinct/a.ts', '/w/outcome/a.ts',
  ]) assert.ok(!isIgnoredPath(p), p)
})

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function makeRepo(t: import('node:test').TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-changes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '--quiet')
  git(root, 'config', 'user.email', 'tests@example.invalid')
  git(root, 'config', 'user.name', 'DSH Tests')
  writeFileSync(join(root, 'tracked.ts'), 'original\n')
  git(root, 'add', 'tracked.ts')
  git(root, 'commit', '--quiet', '-m', 'baseline')
  return root
}

function useWorkspace(t: import('node:test').TestContext, root: string): void {
  const folders = vscode.workspace.workspaceFolders as unknown as vscode.WorkspaceFolder[]
  const original = folders[0]
  folders[0] = { ...original, uri: vscode.Uri.file(root) }
  t.after(() => { folders[0] = original })
}

function makeTracker(): ChangedFilesTracker {
  const launcher = { paths: { fromDsh: async (p: string) => p } } as unknown as Launcher
  const out = { appendLine: () => undefined } as unknown as vscode.OutputChannel
  return new ChangedFilesTracker(() => launcher, out)
}

function diffUpdate(path: string): SessionUpdate {
  return {
    sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'edit',
    content: [{ type: 'diff', path, oldText: 'before', newText: 'after' }],
  } as SessionUpdate
}

test('tracker keeps only final net changes and filters Git scratch files', async t => {
  const root = makeRepo(t)
  useWorkspace(t, root)
  const tracker = makeTracker()
  await tracker.startSession('session')

  const tracked = join(root, 'tracked.ts')
  const reverted = join(root, 'reverted.ts')
  const created = join(root, 'created.ts')
  const scratch = join(root, 'docs', 'debug.md.git')
  const metadata = join(root, '.git', 'agent-scratch')
  for (const p of [tracked, reverted, created, scratch, metadata]) await tracker.ingestUpdate('session', diffUpdate(p))
  assert.deepEqual(tracker.filesFor('session').map(f => f.path), [tracked, reverted, created].sort())

  writeFileSync(tracked, 'final\n')
  writeFileSync(reverted, 'temporary\n')
  rmSync(reverted)
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(scratch, 'temporary metadata\n')
  writeFileSync(created, 'new\n')
  await tracker.promptSettled('session')

  assert.deepEqual(tracker.filesFor('session'), [
    { path: created, label: 'created.ts', kind: 'created' },
    { path: tracked, label: 'tracked.ts', kind: 'modified' },
  ])

  rmSync(created)
  writeFileSync(tracked, 'original\n')
  let lastFiles = tracker.filesFor('session')
  tracker.onDidChange(e => { lastFiles = e.files })
  await tracker.promptSettled('session')
  assert.deepEqual(lastFiles, [])
  assert.deepEqual(tracker.filesFor('session'), [])
})

test('tracker preserves live changes when the final Git query fails', async t => {
  const root = makeRepo(t)
  useWorkspace(t, root)
  const tracker = makeTracker()
  await tracker.startSession('session')
  const tracked = join(root, 'tracked.ts')
  await tracker.ingestUpdate('session', diffUpdate(tracked))

  rmSync(join(root, '.git'), { recursive: true })
  await tracker.promptSettled('session')
  assert.deepEqual(tracker.filesFor('session').map(f => f.path), [tracked])
})
