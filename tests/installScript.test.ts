import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPosixInstallScript, PATCH_YML } from '../src/bridge/installScript.ts'

test('generated installer script is valid bash and contains all required rows', () => {
  const script = buildPosixInstallScript('node /x/bin.js', 'dsh-vscode-bridge')
  const f = join(tmpdir(), `install-${process.pid}.sh`)
  writeFileSync(f, script)
  execFileSync('bash', ['-n', f]) // syntax check only (set -e never runs)
  assert.match(script, /@deepseek-ai\/dsh-acp-app/)                 // bundle repair
  assert.match(script, /dsh-tool-subagent\/model-selection-settings/) // standard preset host row
  assert.match(script, /dsh-vscode-bridge/)
  assert.ok(PATCH_YML.includes('dsh-agent-presets'))
})
