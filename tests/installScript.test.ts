import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { buildBridgeRegistryQueryScript, buildPosixInstallScript, buildVersionProbeScript } from '../src/bridge/installScript.ts'

const posixOnly = { skip: process.platform === 'win32' }

test('generated installer is valid bash and contains no versioned preset snapshot', () => {
  const script = buildPosixInstallScript('node /x/bin.js', 'dsh-vscode-bridge')
  const f = join(tmpdir(), `install-${process.pid}.sh`)
  writeFileSync(f, script)
  execFileSync('bash', ['-n', f])
  assert.match(script, /@deepseek-ai\/dsh-acp-app/)
  assert.match(script, /@deepseek-ai\/dsh-workspace/)
  assert.match(script, /dsh-vscode-bridge/)
  assert.doesNotMatch(script, /dsh-agent-presets|dsh-agent-preset-registry|model-selection-settings/)
  assert.doesNotMatch(script, /--version/)
})

test('registry query requests online compatibility metadata with bounded retries', () => {
  const script = buildBridgeRegistryQueryScript()
  assert.match(script, /npm view 'dsh-vscode-bridge@>=0\.1\.1'/)
  assert.match(script, /dshCompatibility/)
  assert.match(script, /devDependencies\.@deepseek-ai\/dsh-agent/)
  assert.match(script, /--fetch-retries=1/)
  assert.match(script, /--fetch-timeout=15000/)
  assert.match(script, /NVM_DIR/)
})

test('the host-version probe is valid bash and extracts the semver', () => {
  const script = buildVersionProbeScript('dsh')
  const f = join(tmpdir(), `probe-${process.pid}.sh`)
  writeFileSync(f, script)
  execFileSync('bash', ['-n', f])
  assert.match(script, /--version/)
  assert.match(script, /NVM_DIR/)
  assert.match(script, /\(-\[0-9A-Za-z\.\-\]\+\)\?/)
})

/** A fake dsh CLI: creates the profile skeleton and records plugin installs. */
function fakeDsh(): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'fake-dsh-')), 'dsh.sh')
  writeFileSync(bin, `#!/bin/bash
PROF="$DSH_HOME/profiles/acp-vscode"
case "$1" in
  --profile)
    mkdir -p "$PROF"
    [ -f "$PROF/package.json" ] || printf '{ "dsh": { "profile": { "bundles": [] } } }\\n' > "$PROF/package.json"
    [ -f "$PROF/cordis.patch.yml" ] || printf '[]\\n' > "$PROF/cordis.patch.yml"
    ;;
  plugin)
    printf '%s\n' "$5" >> "$DSH_HOME/plugin-adds.log"
    node -e '
const fs = require("fs")
const p = process.argv[1] + "/package.json"
const before = fs.readFileSync(p, "utf8")
const d = JSON.parse(before)
const spec = process.argv[2]
d.dependencies = { ...d.dependencies, "dsh-vscode-bridge": spec.slice(spec.lastIndexOf("@") + 1) }
const after = JSON.stringify(d, null, 2) + "\\n"
if (after !== before) fs.writeFileSync(p, after)
' "$PROF" "$5"
    ;;
esac
`)
  chmodSync(bin, 0o755)
  return bin
}

function runInstaller(seedPatch?: string, home?: string, pkg = 'dsh-vscode-bridge@test') {
  home ??= mkdtempSync(join(tmpdir(), 'dsh-home-'))
  if (seedPatch !== undefined) {
    const prof = join(home, 'profiles', 'acp-vscode')
    mkdirSync(prof, { recursive: true })
    writeFileSync(join(prof, 'package.json'), '{ "dsh": { "profile": { "bundles": [] } } }\n')
    writeFileSync(join(prof, 'cordis.patch.yml'), seedPatch)
  }
  const script = buildPosixInstallScript(fakeDsh(), pkg)
  const stdout = execFileSync('bash', ['-c', script], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  const patchPath = join(home, 'profiles', 'acp-vscode', 'cordis.patch.yml')
  const text = readFileSync(patchPath, 'utf8')
  const patches = parse(text) as ({ insert?: { id?: string, name?: string }[] } | { id?: string })[]
  assert.ok(Array.isArray(patches), 'cordis.patch.yml must remain a top-level YAML array')
  return { home, stdout, text, patches, patchPath }
}

test('fresh installation writes only workspace and bridge activation rows', posixOnly, () => {
  const result = runInstaller()
  const inserted = result.patches.flatMap(patch => 'insert' in patch ? patch.insert ?? [] : [])
  assert.deepEqual(inserted.map(row => [row.id, row.name]), [
    ['workspace', '@deepseek-ai/dsh-workspace'],
    ['dsh-vscode-bridge', 'dsh-vscode-bridge'],
  ])
  const manifest = JSON.parse(readFileSync(join(result.home, 'profiles', 'acp-vscode', 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-acp-app'])
  assert.equal(manifest.dependencies['dsh-vscode-bridge'], 'test')
})

test('repeat installation is idempotent and still forwards the selected package spec', posixOnly, () => {
  const first = runInstaller(undefined, undefined, 'dsh-vscode-bridge@0.5.2')
  const firstManifest = readFileSync(join(first.home, 'profiles', 'acp-vscode', 'package.json'), 'utf8')
  const second = runInstaller(undefined, first.home, 'dsh-vscode-bridge@0.5.2')
  assert.equal(second.text, first.text)
  assert.equal(readFileSync(join(first.home, 'profiles', 'acp-vscode', 'package.json'), 'utf8'), firstManifest)
  assert.deepEqual(readFileSync(join(first.home, 'plugin-adds.log'), 'utf8').trim().split('\n'), [
    'dsh-vscode-bridge@0.5.2', 'dsh-vscode-bridge@0.5.2',
  ])
})

test('hand-edited activation rows with custom ids and quote styles are recognized', posixOnly, () => {
  const seed = `# user-owned layout
- insert:
    - id: my-workspace
      name: "@deepseek-ai/dsh-workspace"
    - id: my-bridge
      name: dsh-vscode-bridge
- id: permission
  config:
    presets: {}
`
  const first = runInstaller(seed)
  assert.equal(first.text, seed)
  const second = runInstaller(undefined, first.home)
  assert.equal(second.text, seed)
})

test('existing user patches gain only missing rows through an atomic replacement', posixOnly, () => {
  const seed = `- insert:
    - id: custom-bridge
      name: 'dsh-vscode-bridge'
- id: permission
  config:
    presets: {}
`
  const result = runInstaller(seed)
  const inserted = result.patches.flatMap(patch => 'insert' in patch ? patch.insert ?? [] : [])
  assert.deepEqual(inserted.map(row => row.id), ['custom-bridge', 'workspace'])
  assert.equal(result.patches.filter(patch => 'insert' in patch).length, 2)
  assert.match(result.text, /id: permission/)
  assert.doesNotMatch(result.stdout, /agent-preset/)
})
