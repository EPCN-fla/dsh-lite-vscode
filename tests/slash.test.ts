import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterSlashCommands, findSlashCommand, type SlashCommand } from '../src/webview/slash.ts'

const CMDS: SlashCommand[] = [
  { name: 'file', label: '文件', description: '附加工作区文件', section: '指令', run: 'local' },
  { name: 'model', label: '模型', description: '选择模型', section: '指令', run: 'local' },
  { name: 'new', label: '新会话', description: '开始新会话', section: '指令', run: 'local' },
  { name: 'compact', label: 'compact', description: '压缩以上对话内容', section: '指令', run: 'native' },
  { name: 'plan', label: 'plan', description: '进入或退出计划模式', section: '指令', run: 'native', hint: '[off|message]' },
  { name: 'dsh-benchmark-case', label: 'dsh-benchmark-case', description: 'Use when…', section: '技能', run: 'skill' },
]

test('filterSlashCommands: empty or blank query returns the full list', () => {
  assert.equal(filterSlashCommands(CMDS, '').length, 6)
  assert.equal(filterSlashCommands(CMDS, '  ').length, 6)
})

test('filterSlashCommands matches by English name (case-insensitive, substring)', () => {
  assert.deepEqual(filterSlashCommands(CMDS, 'mo').map(c => c.name), ['model'])
  assert.deepEqual(filterSlashCommands(CMDS, 'MO').map(c => c.name), ['model'])
  assert.deepEqual(filterSlashCommands(CMDS, 'e').map(c => c.name), ['file', 'model', 'new', 'dsh-benchmark-case'])
})

test('filterSlashCommands matches by Chinese label', () => {
  assert.deepEqual(filterSlashCommands(CMDS, '模型').map(c => c.name), ['model'])
  assert.deepEqual(filterSlashCommands(CMDS, '新').map(c => c.name), ['new'])
})

test('filterSlashCommands: no match yields an empty list', () => {
  assert.deepEqual(filterSlashCommands(CMDS, 'zzz'), [])
})

test('findSlashCommand: native commands execute the line verbatim (args kept)', () => {
  assert.deepEqual(findSlashCommand(CMDS, '/compact'), { kind: 'native', line: '/compact' })
  assert.deepEqual(findSlashCommand(CMDS, '/plan off'), { kind: 'native', line: '/plan off' })
  assert.deepEqual(findSlashCommand(CMDS, '  /plan 详细设计  '), { kind: 'native', line: '/plan 详细设计' })
})

test('findSlashCommand: bare local names resolve to the local action', () => {
  const r = findSlashCommand(CMDS, '/model')
  assert.equal(r?.kind, 'local')
  assert.equal(r?.kind === 'local' && r.cmd.name, 'model')
})

test('findSlashCommand: local commands with arguments fall through to a prompt', () => {
  assert.equal(findSlashCommand(CMDS, '/model gpt'), undefined)
  assert.equal(findSlashCommand(CMDS, '/unknown'), undefined)
  assert.equal(findSlashCommand(CMDS, 'plain text'), undefined)
  assert.equal(findSlashCommand(CMDS, '/'), undefined)
})

test('findSlashCommand: skill lines route to the skill template, args kept', () => {
  assert.deepEqual(findSlashCommand(CMDS, '/dsh-benchmark-case'), { kind: 'skill', name: 'dsh-benchmark-case', rest: '' })
  assert.deepEqual(findSlashCommand(CMDS, '/dsh-benchmark-case 审查该仓库'), { kind: 'skill', name: 'dsh-benchmark-case', rest: '审查该仓库' })
})

test('findSlashCommand: native argument-free vs fill-always policy lives in the menu layer', () => {
  // plan is in NATIVE_COMMAND_FILL → menu fills instead of auto-running;
  // compact is not → auto-runs. The line resolution itself stays identical.
  assert.deepEqual(findSlashCommand(CMDS, '/plan'), { kind: 'native', line: '/plan' })
  assert.deepEqual(findSlashCommand(CMDS, '/compact'), { kind: 'native', line: '/compact' })
})
