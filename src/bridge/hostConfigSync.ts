/** Target-host transport for source-selectable, preview-first profile imports. */
import { readFile } from 'node:fs/promises'
import { readConfig } from '../config.js'
import { runTargetShell, runTargetShellStdin } from '../launcher/runTargetShell.js'
import { buildProfileImportScript } from './profileImportScript.js'
import {
  ProfileImportError,
  type ConfigSyncOptions,
  type ConfigSyncSummary,
  type ConfigSyncTransport,
  type ProfileImportHostResult,
  type ProfileImportRequest,
} from './profileImport.js'

async function bundledHostCode(): Promise<string> {
  return await readFile(new URL('./profile-import-host.mjs', import.meta.url), 'utf8')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function homePrefix(): string {
  const home = readConfig().env['DSH_HOME']
  return home ? `export DSH_HOME=${shellQuote(home)}\n` : ''
}

export function buildProfileProbeScript(source: string): string {
  return `${homePrefix()}DSH_HOME="\${DSH_HOME:-$HOME/.dsh}"
PROFILE="$DSH_HOME/profiles/"${shellQuote(source)}
if [ -f "$PROFILE/package.json" ]; then printf 'exists\\n'; fi
`
}

/** Parse only the final JSON line; anchor discovery must never expose configuration text. */
export function parseProfileImportHostResult(stdout: string): ProfileImportHostResult {
  const line = stdout.trim().split('\n').at(-1) ?? ''
  const value = JSON.parse(line) as ProfileImportHostResult
  if (value.ok) return value
  throw new ProfileImportError(value.code, value.packages ?? [])
}

export class HostConfigSyncTransport implements ConfigSyncTransport {
  constructor(private hostCode: () => Promise<string> = bundledHostCode) {}

  async probeSource(source: string): Promise<boolean> {
    const result = await runTargetShell(buildProfileProbeScript(source), 15_000)
    return result.stdout.trim() === 'exists'
  }

  private async run(request: ProfileImportRequest, timeoutMs: number): Promise<ConfigSyncSummary> {
    const cfg = readConfig()
    const script = homePrefix() + buildProfileImportScript(await this.hostCode(), cfg.command, request)
    const result = await runTargetShellStdin(script, timeoutMs)
    const parsed = parseProfileImportHostResult(result.stdout)
    if (!parsed.ok) throw new ProfileImportError(parsed.code, parsed.packages ?? [])
    return parsed.summary
  }

  async preview(source: string, target: string, options: ConfigSyncOptions): Promise<ConfigSyncSummary> {
    return await this.run({ operation: 'preview', source, target, ...options }, 30_000)
  }

  async import(source: string, target: string, options: ConfigSyncOptions, revision: string): Promise<ConfigSyncSummary> {
    return await this.run({ operation: 'import', source, target, ...options, revision }, 60_000)
  }
}
