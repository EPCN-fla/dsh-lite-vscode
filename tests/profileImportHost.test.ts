import { after, test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { buildProfileImportScript } from '../src/bridge/profileImportScript.ts'
import type { ConfigSyncSummary, ProfileImportHostResult, ProfileImportRequest } from '../src/bridge/profileImport.ts'

type Row = Record<string, any>

// Resolve esbuild at runtime instead of bundling its JS API into this test.
const { buildSync } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild')
const buildDir = mkdtempSync(join(tmpdir(), 'profile-import-test-build-'))
const hostBundle = join(buildDir, 'host.mjs')
buildSync({
  entryPoints: ['src/bridge/profileImportHost.ts'],
  bundle: true, format: 'esm', platform: 'node', target: 'node22',
  outfile: hostBundle, logLevel: 'warning',
})
const hostCode = readFileSync(hostBundle, 'utf8')
after(() => rmSync(buildDir, { recursive: true, force: true }))

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function packagePath(modules: string, name: string): string {
  return join(modules, ...name.split('/'))
}

const BOOT_CODE = `
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
export function loadOverlayPatches(_bin, path) {
  const rows = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(rows)) throw new Error('patch must be an array')
  return rows
}
function packageDirFromAnchor(anchor, name) {
  for (const searchPath of createRequire(anchor).resolve.paths(name) || []) {
    const candidate = join(searchPath, name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
}
export function resolveBundleDir(_bin, name, installAnchor, profileDir) {
  for (const anchor of [installAnchor, join(profileDir, 'package.json')]) {
    const dir = packageDirFromAnchor(anchor, name)
    if (dir) return dir
  }
  throw new Error('not found')
}
export async function createRuntimeResolution({ installAnchor }) {
  const entries = []
  const seen = new Set()
  const queue = [installAnchor]
  while (queue.length) {
    const anchor = queue.shift()
    const manifest = JSON.parse(readFileSync(anchor, 'utf8'))
    if (!seen.has(manifest.name)) {
      seen.add(manifest.name)
      entries.push({ name: manifest.name, packageDir: dirname(anchor) })
    }
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const name of Object.keys(dependencies)) {
      if (seen.has(name)) continue
      const dir = packageDirFromAnchor(anchor, name)
      if (dir) queue.push(join(dir, 'package.json'))
    }
  }
  return { entries }
}
export function composeEntries(layers) {
  const data = []
  const patches = structuredClone(layers.flat())
  const ids = new Map()
  const index = rows => {
    for (const row of rows) {
      if (row.id) ids.set(row.id, row)
      if (row.group === true && Array.isArray(row.config)) index(row.config)
    }
  }
  for (const patch of patches) {
    if (patch.insert) {
      if (patch.id) {
        const target = ids.get(patch.id)
        if (!target || !target.group) continue
        if (!Array.isArray(target.config)) target.config = []
        target.config.push(...patch.insert)
      } else data.push(...patch.insert)
      index(patch.insert)
      continue
    }
    const target = ids.get(patch.id)
    if (!target || (patch.name && patch.name !== target.name)) continue
    for (const [key, value] of Object.entries(patch)) {
      if (!['id', 'insert', 'name'].includes(key)) target[key] = value
    }
  }
  return data
}
`

interface Fixture {
  root: string
  home: string
  anchor: string
  modules: string
  sourceDir: string
  targetDir: string
  webAppDir: string
  writeSource(rows: Row[]): void
  writeTarget(rows: Row[]): void
}

function fixture(t: TestContext, source = 'custom-source', target = 'target-profile'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'profile-import-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'dsh-home')
  const modules = join(root, 'installation', 'node_modules')
  const cliDir = packagePath(modules, '@deepseek-ai/dsh')
  const anchor = join(cliDir, 'package.json')
  const cliDependencies: Record<string, string> = {}
  const install = (name: string, parent?: string): string => {
    const base = parent ? join(parent, 'node_modules') : modules
    const dir = packagePath(base, name)
    json(join(dir, 'package.json'), { name, version: '1.0.0', type: 'module' })
    if (parent) {
      const manifestPath = join(parent, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Row
      manifest.dependencies = { ...manifest.dependencies, [name]: '*' }
      json(manifestPath, manifest)
    } else cliDependencies[name] = '*'
    return dir
  }
  const bootDir = install('@deepseek-ai/dsh-app-boot')
  writeFileSync(join(bootDir, 'index.js'), BOOT_CODE)
  const includeDir = install('@deepseek-ai/cordis-plugin-include')
  writeFileSync(join(includeDir, 'index.js'), 'export const entryListSchema = "fixture-schema"\n')
  const yamlDir = install('js-yaml')
  writeFileSync(join(yamlDir, 'index.js'), 'export function dump(value) { return JSON.stringify(value, null, 2) + "\\n" }\n')
  for (const name of [
    '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-agent-preset',
    '@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-tool-subagent',
  ]) install(name)
  const webAppDir = install('@deepseek-ai/dsh-web-app')
  // Deliberately NOT visible from installation/target top-level Node resolution.
  install('@deepseek-ai/dsh-tool-office', webAppDir)
  json(anchor, { name: '@deepseek-ai/dsh', version: '1.0.0', type: 'module', dependencies: cliDependencies })
  const sourceDir = join(home, 'profiles', source)
  const targetDir = join(home, 'profiles', target)
  for (const dir of [sourceDir, targetDir]) {
    json(join(dir, 'package.json'), { name: `profile-${dir === sourceDir ? source : target}`, dsh: { profile: { bundles: [] } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  }
  return {
    root, home, anchor, modules, sourceDir, targetDir, webAppDir,
    writeSource(rows) { json(join(sourceDir, 'cordis.patch.yml'), rows) },
    writeTarget(rows) { json(join(targetDir, 'cordis.patch.yml'), rows) },
  }
}

function request(f: Fixture, overrides: Partial<ProfileImportRequest> = {}): ProfileImportRequest {
  return {
    operation: 'preview', source: 'custom-source', target: 'target-profile',
    models: true, presets: true, overwrite: false, ...overrides,
  }
}

function runHost(f: Fixture, req: ProfileImportRequest): { result: ProfileImportHostResult, stdout: string } {
  const child = spawnSync(process.execPath, [hostBundle], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: join(f.root, 'unused-home'),
      DSH_HOME: f.home,
      DSH_IMPORT_ANCHOR: f.anchor,
      DSH_IMPORT_REQUEST: JSON.stringify(req),
    },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  assert.equal(child.stdout.trim().split('\n').length, 1, 'host protocol must be one JSON line')
  return { result: JSON.parse(child.stdout) as ProfileImportHostResult, stdout: child.stdout }
}

function okSummary(result: ProfileImportHostResult): ConfigSyncSummary {
  assert.ok(result.ok, JSON.stringify(result))
  return result.summary
}

function errorCode(result: ProfileImportHostResult): string {
  assert.ok(!result.ok, JSON.stringify(result))
  return result.code
}

function seedConfiguration(f: Fixture): void {
  f.writeSource([{ insert: [
    {
      id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
        shared: { token: 'SOURCE_SECRET', models: ['new-model'] },
        'new-provider': { token: 'NEW_SECRET', models: ['added-model'] },
      } },
    },
    { id: 'source-preset-row', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'same-preset', prompt: 'source prompt', plugins: [{ name: '@deepseek-ai/dsh-tool-office', config: { token: 'PLUGIN_SECRET' } }],
    } },
    { id: 'preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: {} },
    { id: 'model-selection', name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings', config: {} },
  ] }])
  f.writeTarget([{ insert: [
    {
      id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
        shared: { token: 'TARGET_SECRET', models: ['old-model'] },
        'target-only': { token: 'KEEP_SECRET', models: ['target-model'] },
      } },
    },
    { id: 'target-preset-row', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'same-preset', prompt: 'target prompt' } },
  ] }])
}

function appliedRows(patchPath: string): Row[] {
  const patches = JSON.parse(readFileSync(patchPath, 'utf8')) as Row[]
  const rows = structuredClone(patches.flatMap(patch => Array.isArray(patch.insert) ? patch.insert : []))
  for (const patch of patches) {
    if (patch.insert || !patch.id) continue
    const row = rows.find(item => item.id === patch.id)
    if (!row) continue
    for (const [key, value] of Object.entries(patch)) {
      if (!['id', 'name', 'insert'].includes(key)) row[key] = value
    }
  }
  return rows
}

test('custom source preview/import honors model options, revision, backup and atomic file modes', t => {
  const f = fixture(t)
  seedConfiguration(f)
  assert.ok(!existsSync(join(f.home, 'profiles', 'web')), 'fixture proves no implicit web source is read')
  const before = readFileSync(join(f.targetDir, 'cordis.patch.yml'), 'utf8')
  const previewRequest = request(f, { presets: false })
  const preview = okSummary(runHost(f, previewRequest).result)
  assert.equal(preview.source, 'custom-source')
  assert.equal(preview.target, 'target-profile')
  assert.match(preview.revision, /^[a-f0-9]{64}$/)
  assert.deepEqual(preview.providers, ['new-provider'])
  assert.deepEqual(preview.skipped, ['provider:shared'])
  assert.deepEqual(preview.presets, [])
  assert.equal(preview.changed, true)
  assert.equal(readFileSync(join(f.targetDir, 'cordis.patch.yml'), 'utf8'), before)

  const imported = okSummary(runHost(f, { ...previewRequest, operation: 'import', revision: preview.revision }).result)
  assert.equal(imported.source, 'custom-source')
  assert.ok(imported.backupPath)
  assert.equal(readFileSync(imported.backupPath, 'utf8'), before)
  assert.equal(statSync(imported.backupPath).mode & 0o777, 0o600)
  const targetPatch = join(f.targetDir, 'cordis.patch.yml')
  assert.equal(statSync(targetPatch).mode & 0o777, 0o600)
  const model = appliedRows(targetPatch).find(row => row.id === 'llm-pi-ai')
  assert.ok(model)
  assert.equal(model.config.providers.shared.token, 'TARGET_SECRET')
  assert.equal(model.config.providers['target-only'].token, 'KEEP_SECRET')
  assert.equal(model.config.providers['new-provider'].token, 'NEW_SECRET')
  assert.ok(!appliedRows(targetPatch).some(row => row.name === '@deepseek-ai/dsh-agent-preset-registry'))
  assert.ok(!existsSync(`${targetPatch}.bridge-lock`))
  assert.ok(!readdirSync(f.targetDir).some(name => name.includes('.tmp')))
})

test('overwrite import replaces same-name provider and preset and copies support rows', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const req = request(f, { overwrite: true })
  const preview = okSummary(runHost(f, req).result)
  assert.deepEqual(preview.providers, ['shared', 'new-provider'])
  assert.deepEqual(preview.presets, ['same-preset'])
  assert.deepEqual(preview.supportRows, ['preset-registry', 'model-selection'])
  const result = okSummary(runHost(f, { ...req, operation: 'import', revision: preview.revision }).result)
  assert.equal(result.restartRequired, true)
  const rows = appliedRows(join(f.targetDir, 'cordis.patch.yml'))
  const model = rows.find(row => row.id === 'llm-pi-ai')
  assert.ok(model)
  assert.equal(model.config.providers.shared.token, 'SOURCE_SECRET')
  assert.equal(model.config.providers['target-only'].token, 'KEEP_SECRET')
  const preset = rows.find(row => row.id === 'target-preset-row')
  assert.ok(preset)
  assert.equal(preset.config.prompt, 'source prompt')
  assert.ok(rows.some(row => row.id === 'preset-registry'))
  assert.ok(rows.some(row => row.id === 'model-selection'))
  const raw = JSON.parse(readFileSync(join(f.targetDir, 'cordis.patch.yml'), 'utf8')) as Row[]
  assert.equal(raw.filter(patch => patch.id === 'llm-pi-ai' || patch.id === 'target-preset-row').length, 0,
    'user-owned insertions are overwritten in place instead of receiving tail overrides')
  const insertedIds = raw.flatMap(patch => patch.insert ?? []).map(row => row.id)
  assert.equal(new Set(insertedIds).size, insertedIds.length, 'the raw YAML contains no duplicate inserted rows')
})

test('repeated overwrite imports update rows without growing the patch document', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const req = request(f, { overwrite: true })
  const patchPath = join(f.targetDir, 'cordis.patch.yml')
  const apply = (): void => {
    const preview = okSummary(runHost(f, req).result)
    okSummary(runHost(f, { ...req, operation: 'import', revision: preview.revision }).result)
  }
  apply()
  const first = JSON.parse(readFileSync(patchPath, 'utf8')) as Row[]
  const sourcePath = join(f.sourceDir, 'cordis.patch.yml')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Row[]
  source[0]!.insert[0].config.providers.shared.token = 'SOURCE_SECRET_V2'
  source[0]!.insert[1].config.prompt = 'source prompt v2'
  json(sourcePath, source)
  apply()
  const second = JSON.parse(readFileSync(patchPath, 'utf8')) as Row[]
  assert.equal(second.length, first.length, 'a second overwrite adds no tail patches')
  assert.equal(second.filter(patch => !patch.insert).length, 0, 'no override-only duplicates are introduced')
  const rows = appliedRows(patchPath)
  assert.equal(rows.find(row => row.id === 'llm-pi-ai')!.config.providers.shared.token, 'SOURCE_SECRET_V2')
  assert.equal(rows.find(row => row.id === 'target-preset-row')!.config.prompt, 'source prompt v2')
})

test('legacy tail overrides fold into user insertions on the next overwrite', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const sourcePath = join(f.sourceDir, 'cordis.patch.yml')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Row[]
  source[0]!.insert[0].config.providers.shared.token = 'SOURCE_SECRET_V3'
  source[0]!.insert[1].config.prompt = 'source prompt v3'
  json(sourcePath, source)

  const patchPath = join(f.targetDir, 'cordis.patch.yml')
  const legacy = JSON.parse(readFileSync(patchPath, 'utf8')) as Row[]
  legacy.push(
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', inject: { legacyPolicy: true }, config: {
      ownField: 'legacy-v1', providers: {
        shared: { token: 'LEGACY_V1' }, 'target-only': { token: 'KEEP_SECRET' },
      },
    } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', disabled: true, config: {
      ownField: 'legacy-v2', providers: {
        shared: { token: 'LEGACY_V2' }, 'target-only': { token: 'KEEP_SECRET' },
      },
    } },
    { id: 'target-preset-row', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'same-preset', prompt: 'legacy preset v1',
    } },
    { id: 'target-preset-row', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'same-preset', prompt: 'legacy preset v2',
    } },
  )
  f.writeTarget(legacy)

  const req = request(f, { overwrite: true })
  const preview = okSummary(runHost(f, req).result)
  okSummary(runHost(f, { ...req, operation: 'import', revision: preview.revision }).result)
  const raw = JSON.parse(readFileSync(patchPath, 'utf8')) as Row[]
  const importedIds = new Set(['llm-pi-ai', 'target-preset-row'])
  assert.equal(raw.filter(patch => !patch.insert && importedIds.has(patch.id)).length, 0,
    'the import compacts overrides left by earlier versions')
  assert.doesNotMatch(JSON.stringify(raw), /LEGACY_V1|LEGACY_V2|legacy preset v[12]/,
    'stale definitions do not remain in the raw patch document')
  const insertedIds = raw.flatMap(patch => patch.insert ?? []).map(row => row.id)
  assert.equal(new Set(insertedIds).size, insertedIds.length)

  const rows = appliedRows(patchPath)
  const model = rows.find(row => row.id === 'llm-pi-ai')!
  assert.equal(model.config.providers.shared.token, 'SOURCE_SECRET_V3')
  assert.equal(model.config.providers['target-only'].token, 'KEEP_SECRET')
  assert.equal(model.config.ownField, 'legacy-v2')
  assert.deepEqual(model.inject, { legacyPolicy: true })
  assert.equal(model.disabled, true)
  assert.equal(rows.find(row => row.id === 'target-preset-row')!.config.prompt, 'source prompt v3')
})

test('inherited rows retain one coalesced override and its lifecycle policies', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const bundleDir = packagePath(join(f.targetDir, 'node_modules'), 'fixture-base')
  json(join(bundleDir, 'package.json'), { name: 'fixture-base', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  json(join(bundleDir, 'cordis.patch.yml'), [{ insert: [{
    id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { inherited: { keep: true } } },
  }] }])
  const manifestPath = join(f.targetDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles = ['fixture-base']
  json(manifestPath, manifest)
  f.writeTarget([
    { id: 'llm-pi-ai', inject: { inheritedPolicy: true }, config: { providers: { shared: { token: 'OLD_V1' } } } },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', disabled: true, config: { providers: {
      shared: { token: 'TARGET_SECRET' }, 'target-only': { token: 'KEEP_SECRET' },
    } } },
  ])
  const req = request(f, { overwrite: true, presets: false })
  const preview = okSummary(runHost(f, req).result)
  okSummary(runHost(f, { ...req, operation: 'import', revision: preview.revision }).result)
  const patchPath = join(f.targetDir, 'cordis.patch.yml')
  const imported = JSON.parse(readFileSync(patchPath, 'utf8')) as Row[]
  const overrides = imported.filter(patch => !patch.insert && patch.id === 'llm-pi-ai')
  assert.equal(overrides.length, 1, 'all inherited-row overrides are coalesced')
  assert.deepEqual(overrides[0]!.inject, { inheritedPolicy: true })
  assert.equal(overrides[0]!.disabled, true)
  assert.equal(overrides[0]!.config.providers.shared.token, 'SOURCE_SECRET')
  assert.equal(overrides[0]!.config.providers['target-only'].token, 'KEEP_SECRET')

  const sourcePath = join(f.sourceDir, 'cordis.patch.yml')
  const source = JSON.parse(readFileSync(sourcePath, 'utf8')) as Row[]
  source[0]!.insert[0].config.providers.shared.token = 'SOURCE_SECRET_V2'
  json(sourcePath, source)
  const next = okSummary(runHost(f, req).result)
  okSummary(runHost(f, { ...req, operation: 'import', revision: next.revision }).result)
  const rewritten = JSON.parse(readFileSync(patchPath, 'utf8')) as Row[]
  assert.equal(rewritten.filter(patch => !patch.insert && patch.id === 'llm-pi-ai').length, 1)
  assert.equal(rewritten.length, imported.length, 'subsequent imports do not grow the inherited override layer')
})

test('runtime entries resolve an official package nested under dsh-web-app', t => {
  const f = fixture(t, 'nested-source')
  f.writeSource([{ insert: [
    { id: 'nested-preset', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'nested-preset', plugins: [{ name: '@deepseek-ai/dsh-tool-office', config: {} }],
    } },
  ] }])
  assert.ok(!existsSync(packagePath(f.modules, '@deepseek-ai/dsh-tool-office')))
  assert.ok(existsSync(join(f.webAppDir, 'node_modules', '@deepseek-ai', 'dsh-tool-office', 'package.json')))
  const req = request(f, { source: 'nested-source', models: false, presets: true })
  const preview = okSummary(runHost(f, req).result)
  assert.deepEqual(preview.presets, ['nested-preset'])
  assert.equal(preview.source, 'nested-source')
  const result = okSummary(runHost(f, { ...req, operation: 'import', revision: preview.revision }).result)
  assert.equal(result.changed, true)
})


test('hosts without runtime resolution retain the legacy package lookup fallback', t => {
  const f = fixture(t, 'legacy-host-source')
  const bootEntry = join(packagePath(f.modules, '@deepseek-ai/dsh-app-boot'), 'index.js')
  writeFileSync(bootEntry, BOOT_CODE.replace('export async function createRuntimeResolution', 'async function createRuntimeResolution'))
  f.writeSource([{ insert: [
    { id: 'legacy-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'legacy-preset', plugins: [] } },
  ] }])
  const req = request(f, { source: 'legacy-host-source', models: false })
  const preview = okSummary(runHost(f, req).result)
  assert.deepEqual(preview.presets, ['legacy-preset'])
})

test('a genuinely missing package returns a safe package list and does not write', t => {
  const f = fixture(t)
  f.writeSource([{ insert: [
    { id: 'missing-preset', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'missing-preset', secret: 'DO_NOT_LEAK',
      plugins: [{ name: '@deepseek-ai/dsh-tool-not-installed', config: { credential: 'ALSO_SECRET' } }],
    } },
  ] }])
  const before = readFileSync(join(f.targetDir, 'cordis.patch.yml'), 'utf8')
  const { result, stdout } = runHost(f, request(f, { models: false }))
  assert.equal(errorCode(result), 'config/missing-package')
  assert.deepEqual((result as { packages?: string[] }).packages, ['@deepseek-ai/dsh-tool-not-installed'])
  assert.ok(!stdout.includes('DO_NOT_LEAK'))
  assert.ok(!stdout.includes('ALSO_SECRET'))
  assert.equal(readFileSync(join(f.targetDir, 'cordis.patch.yml'), 'utf8'), before)
})

test('changed options, source name or source content make a revision stale without writes', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const req = request(f, { presets: false })
  const preview = okSummary(runHost(f, req).result)
  const targetPatch = join(f.targetDir, 'cordis.patch.yml')
  const before = readFileSync(targetPatch, 'utf8')
  const changedOptions = runHost(f, { ...req, operation: 'import', overwrite: true, revision: preview.revision })
  assert.equal(errorCode(changedOptions.result), 'config/stale-preview')
  const alternateDir = join(f.home, 'profiles', 'alternate-source')
  mkdirSync(alternateDir, { recursive: true })
  // Identical bytes isolate the source name/input paths as the revision change.
  for (const name of ['package.json', 'cordis.patch.yml']) {
    writeFileSync(join(alternateDir, name), readFileSync(join(f.sourceDir, name), 'utf8'))
  }
  const changedSourceName = runHost(f, { ...req, operation: 'import', source: 'alternate-source', revision: preview.revision })
  assert.equal(errorCode(changedSourceName.result), 'config/stale-preview')
  assert.equal(readFileSync(targetPatch, 'utf8'), before)
  f.writeSource([{ insert: [{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: { changed: {} } } }] }])
  const changedSource = runHost(f, { ...req, operation: 'import', revision: preview.revision })
  assert.equal(errorCode(changedSource.result), 'config/stale-preview')
  assert.equal(readFileSync(targetPatch, 'utf8'), before)
  assert.deepEqual(readdirSync(f.targetDir), ['cordis.patch.yml', 'package.json'])
})


test('a stale final comparison cleans the new backup, temporary file and lock', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const req = request(f, { presets: false })
  const preview = okSummary(runHost(f, req).result)
  const targetPatch = join(f.targetDir, 'cordis.patch.yml')
  const yamlEntry = join(packagePath(f.modules, 'js-yaml'), 'index.js')
  writeFileSync(yamlEntry, `import { writeFileSync } from 'node:fs'
export function dump(value) {
  if (process.env.DSH_TEST_RACE) writeFileSync(process.env.DSH_TEST_TARGET, '[]' + String.fromCharCode(10))
  return JSON.stringify(value, null, 2) + String.fromCharCode(10)
}
`)
  process.env.DSH_TEST_RACE = '1'
  process.env.DSH_TEST_TARGET = targetPatch
  t.after(() => {
    delete process.env.DSH_TEST_RACE
    delete process.env.DSH_TEST_TARGET
  })
  const result = runHost(f, { ...req, operation: 'import', revision: preview.revision }).result
  assert.equal(errorCode(result), 'config/stale-preview')
  assert.equal(readFileSync(targetPatch, 'utf8'), '[]\n', 'the external edit, not an import rename, remains')
  assert.deepEqual(readdirSync(f.targetDir), ['cordis.patch.yml', 'package.json'])
})

test('option and revision validation fails closed without writes', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const before = readFileSync(join(f.targetDir, 'cordis.patch.yml'), 'utf8')
  assert.equal(errorCode(runHost(f, request(f, { models: false, presets: false })).result), 'config/invalid-options')
  assert.equal(errorCode(runHost(f, request(f, { operation: 'import' })).result), 'config/invalid-options')
  assert.equal(errorCode(runHost(f, request(f, { operation: 'import', revision: 'not-a-sha' })).result), 'config/invalid-options')
  assert.equal(errorCode(runHost(f, { ...request(f), unexpected: true } as ProfileImportRequest).result), 'config/invalid-options')
  assert.equal(readFileSync(join(f.targetDir, 'cordis.patch.yml'), 'utf8'), before)
})

test('an existing target lock blocks import without changing the patch', t => {
  const f = fixture(t)
  seedConfiguration(f)
  const req = request(f, { presets: false })
  const preview = okSummary(runHost(f, req).result)
  const targetPatch = join(f.targetDir, 'cordis.patch.yml')
  const before = readFileSync(targetPatch, 'utf8')
  writeFileSync(`${targetPatch}.bridge-lock`, 'held by another process')
  const result = runHost(f, { ...req, operation: 'import', revision: preview.revision }).result
  assert.equal(errorCode(result), 'config/import-busy')
  assert.equal(readFileSync(targetPatch, 'utf8'), before)
})

test('shared overrides, duplicate ids, nested rows and filesystem plugins retain their guards', t => {
  {
    const shared = fixture(t, 'shared-source-2')
    shared.writeSource([{ insert: [
      { id: 'source-row', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'same', prompt: 'source' } },
    ] }])
    shared.writeTarget([{ insert: [
      { id: 'target-row', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'same', prompt: 'target' } },
    ] }])
    json(join(shared.home, 'cordis.patch.yml'), [{ id: 'target-row', config: { id: 'same', prompt: 'shared' } }])
    const req = request(shared, { source: 'shared-source-2', models: false, overwrite: true })
    assert.equal(errorCode(runHost(shared, req).result), 'config/shared-override')
  }
  {
    const f = fixture(t, 'duplicate-source')
    f.writeSource([{ insert: [
      { id: 'duplicate', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'one' } },
      { id: 'duplicate', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'two' } },
    ] }])
    assert.equal(errorCode(runHost(f, request(f, { source: 'duplicate-source', models: false })).result), 'config/duplicate-id')
  }
  {
    const f = fixture(t, 'nested-row-source')
    f.writeSource([{ insert: [{ id: 'group', group: true, config: [
      { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {} } },
    ] }] }])
    assert.equal(errorCode(runHost(f, request(f, { source: 'nested-row-source', presets: false })).result), 'config/nested-row')
  }
  {
    const f = fixture(t, 'local-plugin-source')
    f.writeSource([{ insert: [{ id: 'local', name: '@deepseek-ai/dsh-agent-preset', config: {
      id: 'local', plugins: [{ name: './secret-local-plugin' }],
    } }] }])
    assert.equal(errorCode(runHost(f, request(f, { source: 'local-plugin-source', models: false })).result), 'config/local-plugin')
  }
})

const posixOnly = { skip: process.platform === 'win32' }

function stubHost(): string {
  return `/* A delimiter-only line must not terminate the embedded program.
DSH_PROFILE_IMPORT_HOST
*/
const request = JSON.parse(process.env.DSH_IMPORT_REQUEST)
const summary = {
  source: request.source, target: request.target, revision: '${'a'.repeat(64)}',
  providers: [], presets: [], skipped: [], supportRows: [], changed: false, restartRequired: false,
}
process.stdout.write(JSON.stringify({ ok: true, summary }) + '\\n')
`
}

test('launcher passes bash -n and round-trips JSON quotes without shell evaluation', posixOnly, t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-import-script-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const anchor = join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  json(anchor, { name: '@deepseek-ai/dsh' })
  const injected = join(root, 'INJECTED')
  const req: ProfileImportRequest = {
    operation: 'preview', source: `source ' " $HOME \`touch ${injected}\` $(touch ${injected}) \\ \n end`,
    target: `target'\"$(touch ${injected})`, models: true, presets: true, overwrite: false,
  }
  const script = buildProfileImportScript(stubHost(), 'command-that-must-not-run', req)
  execFileSync('bash', ['-n'], { input: script })
  const temp = join(root, 'tmp')
  mkdirSync(temp)
  const child = spawnSync('bash', ['-s'], {
    input: script, encoding: 'utf8', env: { ...process.env, HOME: root, DSH_HOME: home, TMPDIR: temp },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  const result = JSON.parse(child.stdout) as ProfileImportHostResult
  const summary = okSummary(result)
  assert.equal(summary.source, req.source)
  assert.equal(summary.target, req.target)
  assert.ok(!existsSync(injected), 'request text was evaluated as shell')
  assert.deepEqual(readdirSync(temp), [], 'launcher temporary directory was not cleaned')
})

test('launcher executes the real host through the shared install anchor', posixOnly, t => {
  const f = fixture(t, 'script-source')
  seedConfiguration(f)
  // The shared profiles/node_modules fallback points at this fake installation.
  symlinkSync(f.modules, join(f.home, 'profiles', 'node_modules'), 'dir')
  const req = request(f, { source: 'script-source', presets: false })
  const script = buildProfileImportScript(hostCode, 'command-that-must-not-run', req)
  execFileSync('bash', ['-n'], { input: script })
  const child = spawnSync('bash', ['-s'], {
    input: script, encoding: 'utf8', env: { ...process.env, HOME: f.root, DSH_HOME: f.home, TMPDIR: f.root },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  const summary = okSummary(JSON.parse(child.stdout) as ProfileImportHostResult)
  assert.equal(summary.source, 'script-source')
  assert.deepEqual(summary.providers, ['new-provider'])
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('dsh-profile-import.')), [])
})


test('launcher bootstraps a version-manager node or reports a focused error', posixOnly, t => {
  const f = fixture(t, 'bootstrap-source')
  seedConfiguration(f)
  symlinkSync(f.modules, join(f.home, 'profiles', 'node_modules'), 'dir')
  const req = request(f, { source: 'bootstrap-source', presets: false })
  const script = buildProfileImportScript(hostCode, 'command-that-must-not-run', req)
  const cleanEnv = {
    ...process.env,
    HOME: f.root,
    DSH_HOME: f.home,
    TMPDIR: f.root,
    PATH: '/usr/bin:/bin',
    NVM_DIR: join(f.root, 'missing-nvm'),
  }
  const missing = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: cleanEnv })
  assert.equal(missing.status, 0, missing.stderr)
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, code: 'config/node-unavailable' })

  const voltaBin = join(f.root, '.volta', 'bin')
  mkdirSync(voltaBin, { recursive: true })
  symlinkSync(process.execPath, join(voltaBin, 'node'))
  const child = spawnSync('bash', ['-s'], { input: script, encoding: 'utf8', env: cleanEnv })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  const summary = okSummary(JSON.parse(child.stdout) as ProfileImportHostResult)
  assert.equal(summary.source, 'bootstrap-source')
})

test('launcher discovers a node CLI anchor with a scoped probe and preserves NODE_OPTIONS', posixOnly, t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-import-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  const cliDir = join(root, 'install', 'node_modules', '@deepseek-ai', 'dsh')
  const anchor = join(cliDir, 'package.json')
  const bin = join(cliDir, 'lib', 'bin.js')
  json(anchor, { name: '@deepseek-ai/dsh', type: 'module' })
  mkdirSync(dirname(bin), { recursive: true })
  writeFileSync(bin, `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.OBSERVED_OPTIONS, JSON.stringify({ options: process.env.NODE_OPTIONS, argv: process.argv }))
console.log('dsh 1.0.0')
`)
  const originalProbe = join(root, 'original.cjs')
  writeFileSync(originalProbe, '// original NODE_OPTIONS require remains valid\n')
  const originalOptions = `--require ${originalProbe}`
  const observed = join(root, 'observed.json')
  const code = `if (process.env.DSH_IMPORT_ANCHOR !== process.env.EXPECTED_ANCHOR
  || process.env.NODE_OPTIONS !== process.env.ORIGINAL_NODE_OPTIONS) {
  process.stdout.write('${UNAVAILABLE_FOR_TEST}\\n')
} else {
  ${stubHost()}
}`
  const req = request({} as Fixture)
  const script = buildProfileImportScript(code, `node ${bin}`, req)
  execFileSync('bash', ['-n'], { input: script })
  const temp = join(root, 'tmp')
  mkdirSync(temp)
  const child = spawnSync('bash', ['-s'], {
    input: script, encoding: 'utf8',
    env: {
      ...process.env, HOME: root, DSH_HOME: home, TMPDIR: temp, NODE_OPTIONS: originalOptions,
      EXPECTED_ANCHOR: anchor, ORIGINAL_NODE_OPTIONS: originalOptions, OBSERVED_OPTIONS: observed,
    },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stderr, '')
  assert.ok(JSON.parse(child.stdout).ok, child.stdout)
  const probe = JSON.parse(readFileSync(observed, 'utf8')) as { options: string, argv: string[] }
  assert.ok(probe.options.startsWith(`${originalOptions} --require "`))
  assert.match(probe.options, /probe\.cjs"$/)
  assert.equal(probe.argv.at(-1), '--version')
  assert.deepEqual(readdirSync(temp), [])
})

test('launcher returns safe unavailable JSON when anchor discovery fails', posixOnly, t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-import-no-anchor-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = buildProfileImportScript(hostCode, 'definitely-not-a-dsh-command', request({} as Fixture))
  const child = spawnSync('bash', ['-s'], {
    input: script, encoding: 'utf8', env: { ...process.env, HOME: root, DSH_HOME: join(root, 'home') },
  })
  assert.equal(child.status, 0)
  assert.equal(child.stderr, '')
  assert.deepEqual(JSON.parse(child.stdout), { ok: false, code: 'config/unavailable' })
})

const UNAVAILABLE_FOR_TEST = '{"ok":false,"code":"config/unavailable"}'
