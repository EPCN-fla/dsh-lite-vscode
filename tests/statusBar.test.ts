import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vscode from 'vscode'
import { handleStatusBarClick } from '../src/statusBar.ts'

test('status bar focuses the chat when the view is not visible', async t => {
  const calls: unknown[][] = []
  t.mock.method(vscode.commands, 'executeCommand', async (...args: unknown[]) => { calls.push(args) })
  await handleStatusBarClick(false)
  assert.deepEqual(calls, [['dsh.focusChat']])
})

test('status bar opens filtered commands when the chat is already visible', async t => {
  const calls: unknown[][] = []
  t.mock.method(vscode.commands, 'executeCommand', async (...args: unknown[]) => { calls.push(args) })
  await handleStatusBarClick(true)
  assert.deepEqual(calls, [['workbench.action.quickOpen', '>DSH ']])
})
