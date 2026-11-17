import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  bridgeSetupPrompt,
  buildBridgeInstallationProbeScript,
  parseBridgeInstallationProbe,
} from '../src/bridge/installation.ts'

const posixOnly = { skip: process.platform === 'win32' }

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function probe(profile: string, home: string): string {
  const script = buildBridgeInstallationProbeScript(profile)
  return execFileSync('/bin/bash', ['-c', script], { env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
}

test('installation probe is valid bash and ignores cordis.patch.yml activation edits', posixOnly, () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-installed-'))
  const profile = join(home, 'profiles', 'acp-vscode')
  write(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-vscode-bridge': '0.5.3' } }))
  write(join(profile, 'node_modules', 'dsh-vscode-bridge', 'package.json'), '{ "name": "dsh-vscode-bridge" }')
  write(join(profile, 'cordis.patch.yml'), '# manually disabled: no bridge row here\n[]\n')
  assert.equal(parseBridgeInstallationProbe(probe('acp-vscode', home)), 'installed')
})

test('installation probe requires both the dependency and installed package', posixOnly, () => {
  const home = mkdtempSync(join(tmpdir(), 'bridge-missing-'))
  const profile = join(home, 'profiles', 'acp-vscode')
  write(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-vscode-bridge': '0.5.3' } }))
  assert.equal(parseBridgeInstallationProbe(probe('acp-vscode', home)), 'missing')
  write(join(profile, 'node_modules', 'dsh-vscode-bridge', 'package.json'), '{}')
  assert.equal(parseBridgeInstallationProbe(probe('acp-vscode', home)), 'installed')
  write(join(profile, 'package.json'), '{ "dependencies": {} }')
  assert.equal(parseBridgeInstallationProbe(probe('acp-vscode', home)), 'missing')
})

test('profile names and DSH_HOME are data rather than shell syntax', posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-quote-'))
  const home = join(root, `home with ' quote`)
  const name = `profile with ' quote`
  const profile = join(home, 'profiles', name)
  write(join(profile, 'package.json'), '{ "dependencies": { "dsh-vscode-bridge": "test" } }')
  write(join(profile, 'node_modules', 'dsh-vscode-bridge', 'package.json'), '{}')
  const script = buildBridgeInstallationProbeScript(name, home)
  execFileSync('/bin/bash', ['-n'], { input: script })
  const stdout = execFileSync('/bin/bash', ['-c', script], { encoding: 'utf8' })
  assert.equal(parseBridgeInstallationProbe(stdout), 'installed')
})

test('unreadable or unexpected probe output remains unknown', () => {
  assert.equal(parseBridgeInstallationProbe(''), 'unknown')
  assert.equal(parseBridgeInstallationProbe('installed\nextra'), 'unknown')
})

test('installed but disconnected is never described as a missing package', () => {
  for (const startupFailed of [false, true]) {
    const prompt = bridgeSetupPrompt('installed', startupFailed, 'acp-vscode')
    assert.match(prompt.message, /package is installed/)
    assert.match(prompt.message, /cordis\.patch\.yml/)
    assert.doesNotMatch(prompt.message, /was not detected|Install it now/)
    assert.equal(prompt.actionLabel, '修复 Bridge')
  }
  assert.equal(bridgeSetupPrompt('missing', false, 'acp-vscode').actionLabel, '安装 Bridge')
  assert.match(bridgeSetupPrompt('unknown', false, 'acp-vscode').message, /could not be confirmed/)
})
