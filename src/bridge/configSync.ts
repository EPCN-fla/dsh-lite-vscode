/** Explicit, preview-first profile → connected bridge profile import.
 * Configuration bytes, credentials and host paths never need local FS access.
 */
import * as vscode from 'vscode'
import { readConfig } from '../config.js'
import { BridgeError } from './client.js'
import {
  ProfileImportError,
  type ConfigSyncOptions,
  type ConfigSyncSummary,
  type ConfigSyncTransport,
} from './profileImport.js'

export type { ConfigSyncOptions, ConfigSyncSummary } from './profileImport.js'

export function configSyncPreviewText(summary: ConfigSyncSummary, options: ConfigSyncOptions): string {
  const list = (values: string[]): string => values.length ? values.join(', ') : '(none)'
  return [
    `Source: ${summary.source} → Target: ${summary.target}`,
    `Same-name entries: ${options.overwrite ? 'ADD new and REPLACE complete provider/preset definitions' : 'ADD new; keep target same-name entries (skip)'}`,
    `Providers: ${list(summary.providers)}`,
    `Presets: ${list(summary.presets)}`,
    `Support rows: ${list(summary.supportRows)}`,
    `Skipped: ${list(summary.skipped)}`,
    '',
    'Writes the target profile on the DSH host. Restart the target ACP/bridge process after importing.',
    'Environment variables, OAuth/credential stores and third-party packages are not copied. Existing sessions are not switched automatically.',
  ].join('\n')
}

/** DSH accepts simple directory names, not paths or its dependency-directory sentinel. */
export function validateProfileName(value: string): string | undefined {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || name === 'node_modules' || /[/\\\0]/.test(name)) {
    return 'Enter a profile directory name (not a path).'
  }
  return undefined
}

/** Keep host diagnostics bounded to stable codes and package names: never echo configuration-bearing errors. */
export function configSyncErrorText(error: unknown): string {
  const code = error instanceof BridgeError ? error.dataCode : error instanceof ProfileImportError ? error.code : undefined
  switch (code) {
    case 'config/stale-preview': return 'Configuration changed since the preview. Run the import command again to review a fresh preview; nothing was retried automatically.'
    case 'config/import-busy': return 'Another import holds the target profile lock. Wait for it to finish and try again. Do not remove the lock while an import is running.'
    case 'config/node-unavailable': return 'Node.js was not found on the DSH host. Check dsh.command and your nvm/volta/mise/asdf installation, then retry the import.'
    case 'config/unavailable': return 'Configuration import is unavailable on this host. Check the source/target profiles, host tooling and file permissions.'
    case 'config/same-profile': return 'The source and target are the same profile. Choose a different source profile.'
    case 'config/missing-package': {
      const packages = error instanceof ProfileImportError ? error.packages : []
      return `The target profile is missing a required package. Install the preset dependencies on the DSH host, then preview again.${packages.length ? ` Missing: ${packages.join(', ')}` : ''}`
    }
    case 'config/shared-override': return 'A shared home patch overrides the imported configuration. Resolve the override on the DSH host before importing.'
    default: return 'Could not confirm the import result. If the write request was sent, it may have completed on the DSH host. Check the target configuration and backups before previewing again. No automatic retry was performed.'
  }
}

type Connection = { readonly isOn: boolean; readonly client?: unknown }

/** One controller per activation: repeated command invocations cannot stack confirmations. */
export class ConfigSyncFlow {
  private running = false

  constructor(
    private bridge: Connection,
    private connect: () => Promise<void>,
    private transport: ConfigSyncTransport,
  ) {}

  async run(options: { requireBridge?: boolean } = {}): Promise<void> {
    if (this.running) {
      await vscode.window.showInformationMessage('DSH: a profile configuration import is already open.')
      return
    }
    this.running = true
    const requireBridge = options.requireBridge ?? true
    try {
      if (requireBridge && !this.bridge.isOn) await this.connect()
      const client = this.bridge.client
      if (requireBridge && (!this.bridge.isOn || !client)) {
        await vscode.window.showWarningMessage('DSH: no bridge connected. Open DSH Chat and run Install/Repair Bridge Plugin, then retry the import.')
        return
      }
      const capabilities = (client as { capabilities?: { configSync?: boolean } } | undefined)?.capabilities
      if (requireBridge && !capabilities?.configSync) {
        await vscode.window.showWarningMessage('DSH: this bridge does not advertise configSync. Install/Repair Bridge Plugin (0.4.0 or newer) and restart the target ACP/bridge process.')
        return
      }
      const target = readConfig().profile
      const input = await vscode.window.showInputBox({
        title: 'DSH: Import Profile Configuration',
        prompt: `Source profile in the same DSH_HOME → target "${target}"`,
        value: 'web',
        validateInput: validateProfileName,
      })
      if (input === undefined) return
      const source = input.trim()
      const sourceExists = await this.transport.probeSource(source)
      if (!sourceExists) {
        await vscode.window.showWarningMessage(`DSH: source profile "${source}" does not exist in this DSH_HOME.`)
        return
      }
      const scope = await vscode.window.showQuickPick([
        { label: 'Models and agent presets', models: true, presets: true },
        { label: 'Models only', models: true, presets: false },
        { label: 'Agent presets only', models: false, presets: true },
      ], { title: 'DSH: Choose configuration categories', placeHolder: `Import from "${source}" into "${target}"` })
      if (!scope) return
      const policy = await vscode.window.showQuickPick([
        { label: 'Add new entries only (recommended)', description: 'Keep same-name target providers and presets', overwrite: false },
        { label: 'Add new and overwrite same-name entries', description: 'Replaces complete provider definitions (including model lists) and presets', overwrite: true },
      ], { title: 'DSH: Import conflict policy' })
      if (!policy) return
      const options: ConfigSyncOptions = { models: scope.models, presets: scope.presets, overwrite: policy.overwrite }
      const stillConnected = (): boolean => readConfig().profile === target
        && (!requireBridge || (this.bridge.isOn && this.bridge.client === client))
      if (!stillConnected()) throw new Error('bridge changed')
      const preview = await this.transport.preview(source, target, options)
      if (!stillConnected()) throw new Error('bridge changed')
      if (!preview.changed) {
        await vscode.window.showInformationMessage('DSH: no configuration changes to import.', { modal: true, detail: configSyncPreviewText(preview, options) })
        return
      }
      const confirm = await vscode.window.showWarningMessage('DSH: Import profile configuration?', {
        modal: true, detail: configSyncPreviewText(preview, options),
      }, 'Import')
      if (confirm !== 'Import') return
      // Never apply a reviewed revision to a replacement bridge or target profile.
      if (!stillConnected()) throw new Error('bridge changed')
      const result = await this.transport.import(source, target, options, preview.revision)
      await vscode.window.showInformationMessage(result.changed ? 'DSH: profile configuration imported.' : 'DSH: no configuration changes to import.', {
        modal: true,
        detail: [
          `Source profile: ${result.source}`,
          `Target profile: ${result.target}`,
          ...(result.backupPath ? [`Backup on DSH host: ${result.backupPath}`] : []),
          ...(result.restartRequired ? ['After active turns finish, restart the target ACP/bridge process (for the extension-managed process, run Developer: Reload Window). Existing sessions are not automatically switched to imported models/presets.'] : []),
          'To restore a backup, stop the target process first and restore its cordis.patch.yml on the DSH host.',
        ].join('\n'),
      })
    } catch (error) {
      await vscode.window.showErrorMessage(`DSH: ${configSyncErrorText(error)}`)
    } finally {
      this.running = false
    }
  }
}
