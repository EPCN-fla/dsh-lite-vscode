import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
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

test('PATCH_YML is valid YAML and matches the dsh-vscode-bridge README wiring', () => {
  const doc = parse(PATCH_YML) as ({ insert?: { id: string; name?: string }[] } | { id?: string; config?: { presets?: Record<string, unknown> } })[]
  assert.ok(Array.isArray(doc), 'patch file must be a top-level YAML array')
  const insert = doc.find(e => 'insert' in e && Array.isArray(e.insert)) as { insert: { id: string }[] } | undefined
  assert.deepEqual(insert?.insert.map(r => r.id), ['workspace', 'agent-presets', 'subagent-model-selection-settings', 'dsh-vscode-bridge'])
  const perm = doc.find(e => 'id' in e && e.id === 'permission') as { config?: { presets?: Record<string, unknown> } } | undefined
  assert.deepEqual(Object.keys(perm?.config?.presets ?? {}).sort(), ['danger-full-access', 'read-only', 'workspace-write'])
})

test('installer replaces the untouched [] template instead of appending after it', () => {
  const script = buildPosixInstallScript('node /x/bin.js', 'dsh-vscode-bridge')
  // Appending block-sequence entries after the template's bare flow `[]` is
  // invalid YAML; the placeholder must be detected and overwritten.
  assert.ok(script.includes('"$stripped" = "[]"'), 'placeholder detection missing')
  assert.ok(script.includes('cat > "$PYML"'), 'overwrite path missing')
  assert.ok(script.includes('cat >> "$PYML"'), 'append path for real user content missing')
})
