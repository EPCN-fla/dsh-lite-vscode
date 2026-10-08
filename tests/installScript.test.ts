import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { buildPosixInstallScript, buildVersionProbeScript, PATCH_YML_DSH_0_1_5, PATCH_YML_DSH_0_1_7 } from '../src/bridge/installScript.ts'

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

/** Insert-row ids across EVERY insert block of a patch variant, in order. */
function insertIds(yml: string): string[] {
  const doc = parse(yml) as ({ insert?: { id: string }[] } | { id?: string })[]
  assert.ok(Array.isArray(doc), 'patch file must be a top-level YAML array')
  return doc.flatMap(e => ('insert' in e && Array.isArray(e.insert) ? e.insert.map(r => r.id) : []))
}

test('the host-version probe is valid bash and extracts the semver', () => {
  const script = buildVersionProbeScript('dsh')
  const f = join(tmpdir(), `probe-${process.pid}.sh`)
  writeFileSync(f, script)
  execFileSync('bash', ['-n', f]) // syntax check only
  assert.match(script, /--version/)       // the probe itself
  assert.match(script, /NVM_DIR/)          // version-manager bootstrap
  assert.match(script, /\(-\[0-9A-Za-z\.\-\]\+\)\?/) // keeps the prerelease suffix
})

test('both patch variants are valid YAML and carry their cohort preset rows', () => {
  assert.deepEqual(insertIds(PATCH_YML_DSH_0_1_5), ['workspace', 'agent-presets', 'subagent-model-selection-settings', 'dsh-vscode-bridge'])
  assert.deepEqual(insertIds(PATCH_YML_DSH_0_1_7), [
    'workspace', 'subagent-model-selection-settings', 'dsh-vscode-bridge',
    'agent-preset-registry', 'preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis',
  ])
  assert.ok(PATCH_YML_DSH_0_1_5.includes('@deepseek-ai/dsh-agent-presets'))
  // The 0.1.7 shape uses the split packages; the removed monolith must be gone.
  // (Beware: '@deepseek-ai/dsh-agent-preset' is a prefix-free distinct name.)
  assert.ok(!PATCH_YML_DSH_0_1_7.includes('@deepseek-ai/dsh-agent-presets'))
  assert.ok(PATCH_YML_DSH_0_1_7.includes('@deepseek-ai/dsh-agent-preset-registry'))
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
 *  return the cordis.patch.yml it left (parsed once to prove it is YAML).
 *  seedPatch pre-populates an existing profile patch (the migration paths);
 *  DSH_HOME is returned for rerun/filesystem assertions. */
function runInstaller(version: string, seedPatch?: string, home?: string): { pyml: string; home: string; stdout: string } {
  home ??= mkdtempSync(join(tmpdir(), 'dsh-home-'))
  if (seedPatch !== undefined) {
    const prof = join(home, 'profiles', 'acp-vscode')
    mkdirSync(prof, { recursive: true })
    writeFileSync(join(prof, 'package.json'), '{ "dsh": { "profile": { "bundles": [] } } }\n')
    writeFileSync(join(prof, 'cordis.patch.yml'), seedPatch)
  }
  const script = buildPosixInstallScript(fakeDsh(version), 'dsh-vscode-bridge@test')
  const stdout = execFileSync('bash', ['-c', script], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  const pyml = readFileSync(join(home, 'profiles', 'acp-vscode', 'cordis.patch.yml'), 'utf8')
  assert.ok(Array.isArray(parse(pyml)), 'written cordis.patch.yml must be a top-level YAML array')
  return { pyml, home, stdout }
}

// The installer only ever runs on POSIX targets (WSL/Linux; from a Windows
// host it goes through wsl.exe), and Git Bash would mangle the fake dsh path
// interpolated into the script — execute it in tests only off Windows.
const posixOnly = { skip: process.platform === 'win32' }

test('installer keeps the legacy agent-presets row on a 0.1.5 host', posixOnly, () => {
  assert.match(runInstaller('0.1.5').pyml, /@deepseek-ai\/dsh-agent-presets/)
})

test('installer keeps the legacy agent-presets row on a 0.1.6 host', posixOnly, () => {
  assert.match(runInstaller('0.1.6').pyml, /@deepseek-ai\/dsh-agent-presets/)
})

test('installer wires the declarative preset roster on a 0.1.7 host', posixOnly, () => {
  const pyml = runInstaller('0.1.7-rc.1').pyml
  assert.ok(!pyml.includes('@deepseek-ai/dsh-agent-presets'), 'the removed monolith row is gone')
  assert.match(pyml, /@deepseek-ai\/dsh-agent-preset-registry/)
  for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
    assert.ok(pyml.includes(`id: ${id}`), `${id} declared`)
  }
  assert.match(pyml, /dsh-vscode-bridge/)
})

test('the 0.1.[0-6] glob must not swallow two-digit minors (0.1.10)', posixOnly, () => {
  assert.ok(runInstaller('0.1.10').pyml.includes('agent-preset-registry'))
})

test('installer prefers the 0.1.7 variant when the host version is unparseable', posixOnly, () => {
  // Both directions degrade to a missing preset picker (the foreign cohort's
  // preset packages fail to import entry-level); preferring the newer shape
  // matches the likelier cause of an unparseable --version.
  assert.ok(runInstaller('').pyml.includes('agent-preset-registry'))
})

test('installer migrates an existing 0.1.5-era patch file on a 0.1.7 host', posixOnly, () => {
  const { pyml, home } = runInstaller('0.1.7-rc.1', PATCH_YML_DSH_0_1_5)
  assert.ok(!pyml.includes('@deepseek-ai/dsh-agent-presets'), 'stale row stripped')
  assert.match(pyml, /@deepseek-ai\/dsh-agent-preset-registry/)
  for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
    assert.ok(pyml.includes(`id: ${id}`), `${id} appended`)
  }
  assert.ok(pyml.includes("name: 'dsh-vscode-bridge'"), 'bridge row kept')
  const doc = parse(pyml) as { id?: string; config?: { presets?: Record<string, unknown> } }[]
  const perm = doc.find(e => e.id === 'permission')
  assert.deepEqual(Object.keys(perm?.config?.presets ?? {}).sort(), ['danger-full-access', 'read-only', 'workspace-write'], 'permission metadata kept')
  assert.ok(existsSync(join(home, 'profiles', 'acp-vscode', 'cordis.patch.yml.bak')), 'backup written')
})

test('the migration is idempotent across reruns', posixOnly, () => {
  const first = runInstaller('0.1.7-rc.1', PATCH_YML_DSH_0_1_5)
  const second = runInstaller('0.1.7-rc.1', undefined, first.home)
  assert.equal(second.pyml, first.pyml, 'a second run changes nothing')
})

test('installer leaves an existing legacy patch untouched on a 0.1.5 host', posixOnly, () => {
  const { pyml } = runInstaller('0.1.5', PATCH_YML_DSH_0_1_5)
  assert.equal(pyml, PATCH_YML_DSH_0_1_5)
})

test('installer points at the per-profile provider migration when settings.yaml was imported', posixOnly, () => {
  const { home } = runInstaller('0.1.7-rc.1', PATCH_YML_DSH_0_1_5)
  writeFileSync(join(home, 'settings.yaml.imported'), 'llm-pi-ai:\n  providers: {}\n')
  const rerun = runInstaller('0.1.7-rc.1', undefined, home)
  assert.match(rerun.stdout, /llm-pi-ai/, 'the note names the section to copy')
})

test('no provider note when the profile already carries llm-pi-ai rows', posixOnly, () => {
  const { home } = runInstaller('0.1.7-rc.1', PATCH_YML_DSH_0_1_5)
  writeFileSync(join(home, 'settings.yaml.imported'), 'llm-pi-ai:\n  providers: {}\n')
  const prof = join(home, 'profiles', 'acp-vscode')
  writeFileSync(join(prof, 'cordis.patch.yml'), readFileSync(join(prof, 'cordis.patch.yml'), 'utf8') + '\n- id: llm-pi-ai\n  config:\n    providers: {}\n')
  const rerun = runInstaller('0.1.7-rc.1', undefined, home)
  assert.ok(!rerun.stdout.includes('llm-pi-ai section'), 'note suppressed')
})

test('the installer runs identically fed over stdin (bash -s — the Windows-safe transport)', posixOnly, () => {
  // install.ts pipes the script to `bash -s` because the vendored preset rows
  // push it past the Windows CreateProcess argv limit (spawn ENAMETOOLONG on
  // the wsl.exe path). Guard the transport assumption: the script must not
  // depend on argv positional parameters or -c semantics.
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  const script = buildPosixInstallScript(fakeDsh('0.1.7-rc.1'), 'dsh-vscode-bridge@test')
  execFileSync('bash', ['-s'], { input: script, env: { ...process.env, DSH_HOME: home } })
  const pyml = readFileSync(join(home, 'profiles', 'acp-vscode', 'cordis.patch.yml'), 'utf8')
  assert.match(pyml, /@deepseek-ai\/dsh-agent-preset-registry/)
  assert.ok(Buffer.byteLength(script) > 32767, 'still above the Windows argv limit — stdin stays mandatory')
})
