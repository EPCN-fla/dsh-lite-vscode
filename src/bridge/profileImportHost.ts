/** Secret-free Node entry point for source-selectable, preview-first profile imports. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  ProfileImportError,
  type ConfigSyncOptions,
  type ConfigSyncSummary,
  type ProfileImportHostResult,
  type ProfileImportRequest,
} from './profileImport.js'

type Row = Record<string, unknown> & { id?: string; name?: string; config?: unknown }
type Patch = Row & { insert?: unknown }

interface RuntimeResolutionEntry {
  name: string
  packageDir: string
}

interface ImportHost {
  parse(path: string): Row[]
  compose(layers: Row[][]): Row[]
  bundleDir(name: string, profileDir: string): string
  dump(patches: Row[]): string
}

interface Plan {
  summary: ConfigSyncSummary
  patchText: string | undefined
  output: string
}

interface ParsedRequest {
  operation: ProfileImportRequest['operation']
  source: string
  target: string
  revision?: string
  options: ConfigSyncOptions
}

/** Load the host's own parser/composer and its complete installation resolution. */
async function loadImportHost(anchor: string, home: string): Promise<ImportHost> {
  const require = createRequire(anchor)
  const bootPath = require.resolve('@deepseek-ai/dsh-app-boot')
  const boot = await import(pathToFileURL(bootPath).href) as {
    loadOverlayPatches(bin: string, path: string): Row[]
    composeEntries(layers: Row[][]): Row[]
    resolveBundleDir(bin: string, name: string, anchor: string, dir: string): string
    createRuntimeResolution?(options: { installAnchor: string, home: string }): Promise<{ entries: RuntimeResolutionEntry[] }>
  }
  const hostRequire = createRequire(bootPath)
  const include = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis-plugin-include')).href) as { entryListSchema: unknown }
  const yaml = await import(pathToFileURL(hostRequire.resolve('js-yaml')).href) as {
    dump(value: unknown, options: Record<string, unknown>): string
  }
  // Older hosts only have the two-anchor resolver; retain their legacy behavior.
  const resolution = await boot.createRuntimeResolution?.({ installAnchor: anchor, home })
  const runtimeEntries = new Map<string, string>()
  for (const entry of resolution?.entries ?? []) {
    if (entry && typeof entry.name === 'string' && typeof entry.packageDir === 'string' && entry.packageDir) {
      runtimeEntries.set(entry.name, entry.packageDir)
    }
  }
  return {
    parse: path => boot.loadOverlayPatches('dsh-vscode-bridge', path),
    compose: layers => boot.composeEntries(layers),
    bundleDir: (name, dir) => runtimeEntries.get(name)
      ?? boot.resolveBundleDir('dsh-vscode-bridge', name, anchor, dir),
    dump: patches => yaml.dump(patches, { schema: include.entryListSchema, noRefs: true, lineWidth: -1 }),
  }
}

/** One operation per process; the exclusive target lock also serializes separate invocations. */
class ProfileImport {
  constructor(
    private readonly home: string,
    private readonly source: string,
    private readonly target: string,
    private readonly host: ImportHost,
  ) {}

  async preview(options: ConfigSyncOptions): Promise<ConfigSyncSummary> {
    return (await this.plan(options)).summary
  }

  async import(options: ConfigSyncOptions, revision: string | undefined): Promise<ConfigSyncSummary> {
    if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)) invalidOptions()
    const context = this.context()
    const lockPath = `${context.patchPath}.bridge-lock`
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict('config/import-busy')
      throw error
    }
    try {
      const plan = await this.plan(options)
      if (plan.summary.revision !== revision) conflict('config/stale-preview')
      if (!plan.summary.changed) return plan.summary
      const path = context.patchPath
      const suffix = randomUUID()
      const backupPath = `${path}.bridge-backup-${suffix}`
      const temporary = `${path}.bridge-${suffix}.tmp`
      let committed = false
      let backupCreated = false
      try {
        // Exclusive creates and mode 0600 protect inline credentials in both files.
        if (plan.patchText !== undefined) {
          await exclusiveWrite(backupPath, plan.patchText)
          backupCreated = true
        }
        await exclusiveWrite(temporary, plan.output)
        const latest = await optionalText(path)
        if (latest !== plan.patchText) conflict('config/stale-preview')
        await rename(temporary, path)
        committed = true
        return { ...plan.summary, ...(plan.patchText === undefined ? {} : { backupPath }) }
      } finally {
        // Failure never leaves a new credential-bearing backup or temp file.
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        if (!committed && backupCreated) {
          await unlink(backupPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
      }
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
  }

  private context(): { sourceDir: string, targetDir: string, patchPath: string } {
    const sourceDir = join(this.home, 'profiles', this.source)
    const targetDir = join(this.home, 'profiles', this.target)
    return { sourceDir, targetDir, patchPath: join(targetDir, 'cordis.patch.yml') }
  }

  private async plan(options: ConfigSyncOptions): Promise<Plan> {
    const context = this.context()
    const [sourceReal, targetReal] = await Promise.all([realpath(context.sourceDir), realpath(context.targetDir)])
    if (sourceReal === targetReal) conflict('config/same-profile')
    if (resolve(context.patchPath) !== join(resolve(context.targetDir), 'cordis.patch.yml')) {
      conflict('config/unsupported-target')
    }
    // Refuse patch symlinks: importing must not replace a file owned by another profile.
    for (const path of [join(context.sourceDir, 'cordis.patch.yml'), context.patchPath]) {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (info !== undefined && (!info.isFile() || info.isSymbolicLink())) conflict('config/linked-patch')
    }
    const inputs = new Map<string, string | undefined>()
    const text = async (path: string, optional = false): Promise<string | undefined> => {
      const value = optional ? await optionalText(path) : await readFile(path, 'utf8')
      inputs.set(path, value)
      return value
    }
    const patches = async (path: string, optional = false): Promise<Row[]> => {
      const value = await text(path, optional)
      return value === undefined ? [] : this.host.parse(path)
    }
    const profile = async (dir: string): Promise<{ rows: Row[], patches: Row[], layers: Row[][] }> => {
      const manifest = record(JSON.parse((await text(join(dir, 'package.json'))) as string))
      const bundles = record(record(manifest.dsh).profile).bundles
      if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) conflict('config/invalid-profile')
      const layers: Row[][] = []
      for (const name of bundles) {
        const bundleDir = this.host.bundleDir(name, dir)
        const metadata = record(JSON.parse((await text(join(bundleDir, 'package.json'))) as string))
        const declaration = record(record(metadata.dsh).bundle).patch
        const files = typeof declaration === 'string' ? [declaration] : declaration
        if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) conflict('config/invalid-bundle')
        for (const file of files) layers.push(await patches(resolve(bundleDir, file)))
      }
      const user = await patches(join(dir, 'cordis.patch.yml'), true)
      layers.push(user)
      return { rows: this.host.compose(layers), patches: user, layers }
    }
    const source = await profile(context.sourceDir)
    const target = await profile(context.targetDir)
    // Home patches apply to both profiles; they remain shared and are not copied.
    const shared = await patches(join(this.home, 'cordis.patch.yml'), true)
    const sourceTop = this.host.compose([[{ insert: source.rows }], shared])
    const targetTop = this.host.compose([[{ insert: target.rows }], shared])
    const sourceRows = flatten(sourceTop)
    const targetRows = flatten(targetTop)
    for (const rows of [sourceRows, targetRows]) {
      const ids = new Set<string>()
      const presetIds = new Set<string>()
      for (const row of rows) {
        if (row.id !== undefined && ids.has(row.id)) conflict('config/duplicate-id')
        if (row.id !== undefined) ids.add(row.id)
        if (row.name !== '@deepseek-ai/dsh-agent-preset') continue
        const id = record(row.config).id
        if (typeof id !== 'string' || presetIds.has(id)) conflict('config/duplicate-preset')
        presetIds.add(id)
      }
    }
    // Moving a row out of a group would lose its disabled/injection/isolation policy.
    for (const [rows, top] of [[sourceRows, sourceTop], [targetRows, targetTop]] as const) {
      if (rows.some(row => !top.includes(row) && ((options.models && row.id === 'llm-pi-ai')
        || (options.presets && row.name === '@deepseek-ai/dsh-agent-preset')))) conflict('config/nested-row')
    }
    const additions: Patch[] = []
    const providers: string[] = []
    const presets: string[] = []
    const skipped: string[] = []
    const supportRows: string[] = []
    const patchRow = (row: Row, config: unknown): void => {
      if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') conflict('config/missing-id')
      const existing = targetRows.find(item => item.id === row.id)
      if (existing !== undefined && existing.name !== row.name) conflict('config/row-collision')
      additions.push(existing === undefined
        ? { insert: [{ ...row, config }] }
        : { id: row.id, name: row.name, config, disabled: row.disabled ?? false })
    }
    if (options.models) {
      const model = sourceRows.find(row => row.id === 'llm-pi-ai')
      if (model !== undefined) {
        if (model.name !== '@deepseek-ai/dsh-llm-pi-ai') conflict('config/model-row')
        const config = record(model.config)
        const incoming = record(config.providers)
        const existing = targetRows.find(row => row.id === 'llm-pi-ai')
        const previous = record(existing?.config)
        const previousProviders = record(previous.providers)
        if (Object.hasOwn(incoming, '__jsExpr') || Object.hasOwn(previousProviders, '__jsExpr')) conflict('config/dynamic-providers')
        const merged = { ...previousProviders }
        for (const [id, value] of Object.entries(incoming)) {
          if (Object.hasOwn(merged, id) && !options.overwrite) { skipped.push(`provider:${id}`); continue }
          if (JSON.stringify(merged[id]) === JSON.stringify(value)) continue
          Object.defineProperty(merged, id, { value, enumerable: true, configurable: true, writable: true })
          providers.push(id)
        }
        if (providers.length) patchRow(existing === undefined ? model : { ...model, disabled: existing.disabled ?? false }, {
          ...(existing === undefined ? config : previous), providers: merged,
        })
      }
    }
    if (options.presets) {
      for (const row of sourceRows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')) {
        const id = record(row.config).id
        if (typeof id !== 'string' || !id) conflict('config/invalid-preset')
        const existing = targetRows.find(item => item.name === row.name && record(item.config).id === id)
        if (existing !== undefined && !options.overwrite) { skipped.push(`preset:${id}`); continue }
        if (existing !== undefined && JSON.stringify(existing.config) === JSON.stringify(row.config)
          && existing.disabled === row.disabled) continue
        patchRow(existing === undefined ? row : { ...row, id: existing.id! }, row.config)
        presets.push(id)
      }
      if (presets.length) {
        // Registry and model-routing service are the host prerequisites of imported presets.
        const support = ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-tool-subagent/model-selection-settings']
        const importsCordis = sourceRows.some(row => row.name === '@deepseek-ai/dsh-agent-preset'
          && presets.includes(String(record(row.config).id))
          && containsPlugin(record(row.config).plugins, '@deepseek-ai/dsh-tool-cordis'))
        if (importsCordis) support.push('@deepseek-ai/dsh-cordis-host-runner', '@deepseek-ai/dsh-tool-cordis/host')
        for (const name of support) {
          const row = sourceRows.find(item => item.name === name)
          if (row !== undefined && !targetRows.some(item => item.name === name)) {
            patchRow(row, row.config)
            supportRows.push(row.id!)
          }
        }
      }
    }
    // Rewrite the actual user patch layer, not an append-only override log.
    // Existing user-owned insertions are edited in place; inherited rows keep
    // one coalesced override. Verify the exact output against home patches.
    const outputPatches = mergeImportedPatches(target.patches, additions)
    const resultRows = flatten(this.host.compose([...target.layers.slice(0, -1), outputPatches, shared]))
    for (const addition of additions) {
      const expected = Array.isArray(addition.insert) ? addition.insert as Row[] : [addition]
      for (const row of expected) {
        const applied = resultRows.find(item => item.id === row.id)
        if (JSON.stringify(applied?.config) !== JSON.stringify(row.config)) conflict('config/shared-override')
      }
    }
    // Copy configuration only: every referenced module must already resolve in the target runtime.
    const inspect = (row: Row): void => {
      const name = row.name
      if (name && !name.startsWith('cordis:')) {
        if (name.startsWith('.') || name.startsWith('/') || name.startsWith('file:')) conflict('config/local-plugin')
        const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!
        try { this.host.bundleDir(packageName, context.targetDir) } catch {
          throw new ProfileImportError('config/missing-package', safePackageNames(packageName))
        }
      }
      const config = row.config
      if (row.group === true && Array.isArray(config)) config.forEach(item => inspect(record(item)))
      const plugins = record(Array.isArray(config) ? undefined : config).plugins
      if (Array.isArray(plugins)) plugins.forEach(item => inspect(record(item)))
    }
    for (const addition of additions) {
      if (Array.isArray(addition.insert)) addition.insert.forEach(item => inspect(record(item)))
      else inspect(addition)
    }
    // Native parsers read their files synchronously; ensure no edit raced those reads.
    for (const [path, value] of inputs) {
      if (await optionalText(path) !== value) conflict('config/stale-preview')
    }
    const revision = createHash('sha256').update(JSON.stringify([options, [...inputs]])).digest('hex')
    return {
      summary: {
        source: this.source, target: this.target, revision, providers, presets, skipped, supportRows,
        changed: additions.length > 0, restartRequired: additions.length > 0,
      },
      patchText: inputs.get(context.patchPath),
      output: this.host.dump(outputPatches),
    }
  }
}

/**
 * Merge imported rows into the user layer without accumulating repeated
 * overrides. Patch order between different ids is immaterial; for one id,
 * later fields win just as they do in the Loader composer.
 */
function mergeImportedPatches(current: Row[], additions: Patch[]): Row[] {
  const patches = structuredClone(current)
  const matches = (patch: Row, addition: Patch): boolean => patch.insert === undefined
    && patch.id === addition.id
    && (patch.name === undefined || patch.name === addition.name)

  for (const addition of additions) {
    if (Array.isArray(addition.insert)) {
      patches.push(structuredClone(addition))
      continue
    }

    let inserted: Row | undefined
    for (const patch of patches) {
      if (!Array.isArray(patch.insert)) continue
      inserted = patch.insert.find((row: Row) => row.id === addition.id
        && (addition.name === undefined || row.name === addition.name))
      if (inserted !== undefined) break
    }

    const overrides = patches.filter(patch => matches(patch, addition))
    // Preserve non-config policies from earlier overrides, then apply the
    // imported effective config/disabled state as the final values.
    const policies = Object.assign({}, ...overrides.map(patch => {
      const copy = { ...patch }
      delete copy.config
      delete copy.disabled
      delete copy.name
      return copy
    })) as Row

    if (inserted !== undefined) {
      Object.assign(inserted, policies, {
        id: addition.id,
        ...(addition.name === undefined ? {} : { name: addition.name }),
        config: structuredClone(addition.config),
        disabled: addition.disabled,
      })
      for (let index = patches.length - 1; index >= 0; index--) {
        if (matches(patches[index]!, addition)) patches.splice(index, 1)
      }
      continue
    }

    const replacement = Object.assign({}, policies, structuredClone(addition)) as Row
    const first = patches.findIndex(patch => matches(patch, addition))
    if (first < 0) patches.push(replacement)
    else {
      patches[first] = replacement
      for (let index = patches.length - 1; index > first; index--) {
        if (matches(patches[index]!, addition)) patches.splice(index, 1)
      }
    }
  }
  return patches
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ProfileImportError('config/unavailable')
  return value as Record<string, unknown>
}

function invalidOptions(): never {
  throw new ProfileImportError('config/invalid-options')
}

function requestOf(value: unknown): ParsedRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidOptions()
  const args = value as Record<string, unknown>
  const allowed = ['operation', 'source', 'target', 'models', 'presets', 'overwrite', 'revision']
  for (const key of Object.keys(args)) if (!allowed.includes(key)) invalidOptions()
  if (args.operation !== 'preview' && args.operation !== 'import') invalidOptions()
  for (const key of ['source', 'target']) {
    const name = args[key]
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || name === 'node_modules' || /[/\\\0]/.test(name)) {
      invalidOptions()
    }
  }
  for (const key of ['models', 'presets', 'overwrite']) {
    if (args[key] !== undefined && typeof args[key] !== 'boolean') invalidOptions()
  }
  const options = { models: args.models !== false, presets: args.presets !== false, overwrite: args.overwrite === true }
  if (!options.models && !options.presets) invalidOptions()
  if (args.revision !== undefined && (typeof args.revision !== 'string' || !/^[a-f0-9]{64}$/.test(args.revision))) invalidOptions()
  if (args.operation === 'import' && args.revision === undefined) invalidOptions()
  return {
    operation: args.operation,
    source: args.source as string,
    target: args.target as string,
    revision: args.revision as string | undefined,
    options,
  }
}

function containsPlugin(value: unknown, name: string): boolean {
  if (!Array.isArray(value)) return false
  return value.some(item => {
    const row = record(item)
    return row.name === name || (row.group === true && containsPlugin(row.config, name))
  })
}

function flatten(rows: Row[]): Row[] {
  return rows.flatMap(row => row.group === true && Array.isArray(row.config) ? [row, ...flatten(row.config)] : [row])
}

function conflict(code: string): never {
  throw new ProfileImportError(code)
}

function safePackageNames(name: string): string[] {
  const unscoped = /^[a-z0-9][a-z0-9._-]*$/i
  const scoped = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i
  return unscoped.test(name) || scoped.test(name) ? [name] : []
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function exclusiveWrite(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
}

async function execute(): Promise<ProfileImportHostResult> {
  try {
    const anchor = process.env.DSH_IMPORT_ANCHOR
    if (!anchor || !isAbsolute(anchor)) throw new ProfileImportError('config/unavailable')
    const request = requestOf(JSON.parse(process.env.DSH_IMPORT_REQUEST ?? ''))
    const home = resolve(process.env.DSH_HOME || join(process.env.HOME || homedir(), '.dsh'))
    const host = await loadImportHost(anchor, home)
    const importer = new ProfileImport(home, request.source, request.target, host)
    const summary = request.operation === 'preview'
      ? await importer.preview(request.options)
      : await importer.import(request.options, request.revision)
    return { ok: true, summary }
  } catch (error) {
    if (error instanceof ProfileImportError) {
      return { ok: false, code: error.code, ...(error.packages.length ? { packages: error.packages } : {}) }
    }
    // YAML/JSON and module errors can contain source lines, paths, or credentials.
    return { ok: false, code: 'config/unavailable' }
  }
}

// The host protocol is exactly one JSON line on stdout; never echo caught errors.
process.stdout.write(`${JSON.stringify(await execute())}\n`)
