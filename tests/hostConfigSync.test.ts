import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProfileProbeScript, parseProfileImportHostResult } from '../src/bridge/hostConfigSync.ts'
import { ProfileImportError, type ConfigSyncSummary } from '../src/bridge/profileImport.ts'

const summary: ConfigSyncSummary = {
  source: 'team-profile', target: 'acp-vscode', revision: 'a'.repeat(64),
  providers: [], presets: [], skipped: [], supportRows: [], changed: false, restartRequired: false,
}

test('host result parser returns summaries and converts stable failures without raw diagnostics', () => {
  const parsed = parseProfileImportHostResult(`noise\n${JSON.stringify({ ok: true, summary })}\n`)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.summary, summary)
  assert.throws(
    () => parseProfileImportHostResult(JSON.stringify({ ok: false, code: 'config/missing-package', packages: ['example-package'] })),
    (error: unknown) => error instanceof ProfileImportError && error.code === 'config/missing-package'
      && error.packages.join(',') === 'example-package' && !error.message.includes('SECRET'),
  )
})

test('source profile probe is valid bash and safely handles quotes and spaces', { skip: process.platform === 'win32' }, () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const source = "team's profile"
  mkdirSync(join(home, 'profiles', source), { recursive: true })
  writeFileSync(join(home, 'profiles', source, 'package.json'), '{}\n')
  const script = buildProfileProbeScript(source)
  execFileSync('bash', ['-n'], { input: script })
  const stdout = execFileSync('bash', ['-s'], { input: script, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  assert.equal(stdout.trim(), 'exists')
  const missing = execFileSync('bash', ['-s'], { input: buildProfileProbeScript('missing'), env: { ...process.env, DSH_HOME: home }, encoding: 'utf8' })
  assert.equal(missing.trim(), '')
})
