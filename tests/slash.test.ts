import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSlashCommands, type SlashCommand } from '../src/webview/slash.ts'

const CMDS: SlashCommand[] = [
  { name: 'file', label: '文件', description: '附加工作区文件', icon: '📄' },
  { name: 'model', label: '模型', description: '选择模型', icon: '🧠' },
  { name: 'new', label: '新会话', description: '开始新会话', icon: '✨' },
]

test('filterSlashCommands: empty or blank query returns the full list', () => {
  assert.equal(filterSlashCommands(CMDS, '').length, 3)
  assert.equal(filterSlashCommands(CMDS, '  ').length, 3)
})

test('filterSlashCommands matches by English name (case-insensitive, substring)', () => {
  assert.deepEqual(filterSlashCommands(CMDS, 'mo').map(c => c.name), ['model'])
  assert.deepEqual(filterSlashCommands(CMDS, 'MO').map(c => c.name), ['model'])
  assert.deepEqual(filterSlashCommands(CMDS, 'e').map(c => c.name), ['file', 'model', 'new'])
})

test('filterSlashCommands matches by Chinese label', () => {
  assert.deepEqual(filterSlashCommands(CMDS, '模型').map(c => c.name), ['model'])
  assert.deepEqual(filterSlashCommands(CMDS, '新').map(c => c.name), ['new'])
})

test('filterSlashCommands: no match yields an empty list', () => {
  assert.deepEqual(filterSlashCommands(CMDS, 'zzz'), [])
})
