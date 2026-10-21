import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'

test('CI separates PR tests and tag releases without Actions artifacts', () => {
  const text = readFileSync('.github/workflows/ci.yml', 'utf8')
  const w = parse(text)
  assert.deepEqual(w.on.push, { tags: ['v*'] })
  assert.deepEqual(w.on.pull_request.types, ['opened', 'synchronize', 'reopened'])
  assert.equal(w.jobs['build-test'].if, "github.event_name == 'pull_request'")
  assert.equal(w.jobs['build-test'].strategy['fail-fast'], false)
  assert.equal(w.jobs['build-test'].steps.find((s: any) => s.name === 'Test summary').if, 'always()')
  assert.equal(w.permissions.contents, 'read')
  const publish = w.jobs.publish
  assert.equal(publish.if, "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')")
  assert.equal(publish.permissions.contents, 'write')
  assert.equal(publish.needs, undefined)
  assert.ok(!text.includes('upload-artifact'))
  assert.ok(!publish.steps.some((s: any) => /npm (test|run (test|smoke))/.test(s.run ?? '')))
  const release = publish.steps.find((s: any) => s.name === 'GitHub Release')
  assert.equal(release.with.files, 'dsh-lite-vscode.vsix')
  assert.equal(release.with.fail_on_unmatched_files, true)
  assert.equal(release.with.generateReleaseNotes, true)
  const guard = publish.steps.findIndex((s: any) => s.run === 'node scripts/check-release-version.mjs')
  assert.ok(guard >= 0 && guard < publish.steps.findIndex((s: any) => s.name === 'Build and package'))
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.match(manifest.scripts.test, /--test-reporter=tap/)
})

test('release guard rejects inconsistent tags or lockfile versions', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const script = readFileSync('scripts/check-release-version.mjs', 'utf8')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.3.1' }))
  for (const [tag, version, rootVersion, ok] of [
    ['v0.3.1', '0.3.1', '0.3.1', true],
    ['v0.3.0', '0.3.1', '0.3.1', false],
    ['v0.3.1', '0.3.0', '0.3.1', false],
    ['v0.3.1', '0.3.1', '0.3.0', false],
  ] as const) {
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ version, packages: { '': { version: rootVersion } } }))
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, env: { ...process.env, GITHUB_REF_NAME: tag } })
    assert.equal(r.status === 0, ok, `${tag}/${version}/${rootVersion}`)
  }
})
