import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { buildPosixInstallScript, PATCH_YML_DSH_0_1_5, PATCH_YML_DSH_0_1_7 } from '../src/bridge/installScript.ts'

test('generated installer script is valid bash and probes the host dsh version', () => {
  const script = buildPosixInstallScript('node /x/bin.js', 'dsh-vscode-bridge')
  const f = join(tmpdir(), `install-${process.pid}.sh`)
  writeFileSync(f, script)
  execFileSync('bash', ['-n', f]) // syntax check only (set -e never runs)
  assert.match(script, /@deepseek-ai\/dsh-acp-app/)                 // bundle repair
  assert.match(script, /dsh-tool-subagent\/model-selection-settings/) // standard preset host row
  assert.match(script, /dsh-vscode-bridge/)
  assert.match(script, /--version/)     // host version probe
  assert.match(script, /0\.1\.\[0-6\]/) // the legacy cohort boundary (agent-presets removed in 0.1.7)
})

/** Insert-row ids of a patch variant, in order. */
function insertIds(yml: string): string[] {
  const doc = parse(yml) as ({ insert?: { id: string }[] } | { id?: string })[]
  assert.ok(Array.isArray(doc), 'patch file must be a top-level YAML array')
  const insert = doc.find(e => 'insert' in e && Array.isArray(e.insert)) as { insert: { id: string }[] } | undefined
  return insert?.insert.map(r => r.id) ?? []
}

test('both patch variants are valid YAML and differ only in the agent-presets row', () => {
  assert.deepEqual(insertIds(PATCH_YML_DSH_0_1_5), ['workspace', 'agent-presets', 'subagent-model-selection-settings', 'dsh-vscode-bridge'])
  assert.deepEqual(insertIds(PATCH_YML_DSH_0_1_7), ['workspace', 'subagent-model-selection-settings', 'dsh-vscode-bridge'])
  assert.ok(PATCH_YML_DSH_0_1_5.includes('@deepseek-ai/dsh-agent-presets'))
  // The 0.1.7 shape carries no preset rows at all: the ACP newSession path
  // composes no preset, so the bridge presets capability degrades instead.
  assert.ok(!PATCH_YML_DSH_0_1_7.includes('dsh-agent-preset'))
  // The permission-preset display metadata rides both variants.
  for (const yml of [PATCH_YML_DSH_0_1_5, PATCH_YML_DSH_0_1_7]) {
    const doc = parse(yml) as { id?: string; config?: { presets?: Record<string, unknown> } }[]
    const perm = doc.find(e => e.id === 'permission')
    assert.deepEqual(Object.keys(perm?.config?.presets ?? {}).sort(), ['danger-full-access', 'read-only', 'workspace-write'])
  }
})

test('installer replaces the untouched [] template instead of appending after it', () => {
  const script = buildPosixInstallScript('node /x/bin.js', 'dsh-vscode-bridge')
  // Appending block-sequence entries after the template's bare flow `[]` is
  // invalid YAML; the placeholder must be detected and overwritten.
  assert.ok(script.includes('"$stripped" = "[]"'), 'placeholder detection missing')
  assert.ok(script.includes('cat "$PATCH_TMP" > "$PYML"'), 'overwrite path missing')
  assert.ok(script.includes('cat "$PATCH_TMP" >> "$PYML"'), 'append path for real user content missing')
})

/** A fake dsh CLI good enough for the installer: creates the profile skeleton
 *  (like --from-default-profile acp --dump-config), answers --version, and
 *  accepts plugin add. */
function fakeDsh(version: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'fake-dsh-')), 'dsh.sh')
  writeFileSync(bin, `#!/bin/bash
case "$1" in
  --version) echo "${version}" ;;
  --profile)
    PROF="$DSH_HOME/profiles/acp-vscode"
    mkdir -p "$PROF"
    [ -f "$PROF/package.json" ] || printf '{ "dsh": { "profile": { "bundles": [] } } }\\n' > "$PROF/package.json"
    [ -f "$PROF/cordis.patch.yml" ] || printf '[]\\n' > "$PROF/cordis.patch.yml"
    ;;
  plugin) ;;
esac
`)
  chmodSync(bin, 0o755)
  return bin
}

/** Run the installer end-to-end against a fake dsh of the given version and
 *  return the cordis.patch.yml it wrote (parsed once to prove it is YAML). */
function runInstaller(version: string): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const script = buildPosixInstallScript(fakeDsh(version), 'dsh-vscode-bridge@test')
  execFileSync('bash', ['-c', script], { env: { ...process.env, DSH_HOME: home } })
  const pyml = readFileSync(join(home, 'profiles', 'acp-vscode', 'cordis.patch.yml'), 'utf8')
  assert.ok(Array.isArray(parse(pyml)), 'written cordis.patch.yml must be a top-level YAML array')
  return pyml
}

test('installer keeps the legacy agent-presets row on a 0.1.5 host', () => {
  assert.match(runInstaller('0.1.5'), /@deepseek-ai\/dsh-agent-presets/)
})

test('installer writes no preset rows on a 0.1.7 host', () => {
  const pyml = runInstaller('0.1.7-rc.1')
  assert.ok(!pyml.includes('dsh-agent-preset'))
  assert.match(pyml, /dsh-vscode-bridge/)
})

test('installer prefers the preset-less variant when the host version is unparseable', () => {
  // A bogus agent-presets row breaks the whole profile on 0.1.7, while a
  // missing presets capability merely hides the picker — fail safe.
  assert.ok(!runInstaller('').includes('dsh-agent-preset'))
})
