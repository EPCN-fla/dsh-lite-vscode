/** Explicit, preview-first Web → active bridge profile import (bridge ≥ 0.4.0).
 * Configuration bytes, credentials and host paths never need local FS access.
 */
import * as vscode from 'vscode'
import { BridgeError, type BridgeClient } from './client.js'

export interface ConfigSyncOptions {
  models: boolean
  presets: boolean
  overwrite: boolean
}

export interface ConfigSyncSummary {
  source: 'web'
  target: string
  revision: string
  providers: string[]
  presets: string[]
  skipped: string[]
  supportRows: string[]
  changed: boolean
  restartRequired: boolean
  backupPath?: string
}

type Connection = { readonly isOn: boolean; readonly client?: BridgeClient }

export function configSyncPreviewText(summary: ConfigSyncSummary, options: ConfigSyncOptions): string {
  const list = (values: string[]): string => values.length ? values.join(', ') : '(none)'
  return [
    `Source: ${summary.source} → Target: ${summary.target}`,
    `Same-name entries: ${options.overwrite ? 'REPLACE complete provider/preset definitions' : 'keep target (skip)'}`,
    `Providers: ${list(summary.providers)}`,
    `Presets: ${list(summary.presets)}`,
    `Support rows: ${list(summary.supportRows)}`,
    `Skipped: ${list(summary.skipped)}`,
    '',
    'Writes the target profile on the DSH host. Restart the target ACP/bridge process after importing.',
    'Environment variables, OAuth/credential stores and third-party packages are not copied. Existing sessions are not switched automatically.',
  ].join('\n')
}

/** Keep RPC diagnostics bounded to stable codes: never echo configuration-bearing errors. */
export function configSyncErrorText(error: unknown): string {
  const code = error instanceof BridgeError ? error.dataCode : undefined
  switch (code) {
    case 'config/stale-preview': return 'Configuration changed since the preview. Run the import command again to review a fresh preview; nothing was retried automatically.'
    case 'config/import-busy': return 'Another import holds the target profile lock. Wait for it to finish and try again. Do not remove the lock while an import is running.'
    case 'config/unavailable': return 'Configuration import is unavailable on this host. Check the Web profile, host tooling and file permissions.'
    case 'config/same-profile': return 'The connected target is already the Web profile. Connect to your ACP profile instead.'
    case 'config/missing-package': return 'The target profile is missing a required package. Install the preset dependencies on the DSH host, then preview again.'
    case 'config/shared-override': return 'A shared home patch overrides the imported configuration. Resolve the override on the DSH host before importing.'
    default: return 'Import did not complete. Check the DSH host configuration and bridge connection, then run the command again to preview. No automatic retry was performed.'
  }
}

/** One controller per activation: repeated command invocations cannot stack confirmations. */
export class ConfigSyncFlow {
  private running = false

  constructor(private bridge: Connection, private connect: () => Promise<void>) {}

  async run(): Promise<void> {
    if (this.running) {
      await vscode.window.showInformationMessage('DSH: a Web configuration import is already open.')
      return
    }
    this.running = true
    try {
      if (!this.bridge.isOn) await this.connect()
      const client = this.bridge.client
      if (!this.bridge.isOn || !client) {
        await vscode.window.showWarningMessage('DSH: no bridge connected. Open DSH Chat and run Install/Repair Bridge Plugin, then retry the import.')
        return
      }
      if (!client.capabilities?.configSync) {
        await vscode.window.showWarningMessage('DSH: this bridge does not advertise configSync. Install/Repair Bridge Plugin (0.4.0 or newer) and restart the target ACP/bridge process.')
        return
      }
      const scope = await vscode.window.showQuickPick([
        { label: 'Models and agent presets', models: true, presets: true },
        { label: 'Models only', models: true, presets: false },
        { label: 'Agent presets only', models: false, presets: true },
      ], { title: 'DSH: Import Web Configuration', placeHolder: 'Import from the Web profile in the same DSH_HOME' })
      if (!scope) return
      const policy = await vscode.window.showQuickPick([
        { label: 'Keep existing target entries (recommended)', overwrite: false },
        { label: 'Replace same-name target entries', description: 'Replaces complete provider definitions (including model lists) and presets', overwrite: true },
      ], { title: 'DSH: Import conflict policy' })
      if (!policy) return
      const options: ConfigSyncOptions = { models: scope.models, presets: scope.presets, overwrite: policy.overwrite }
      const stillConnected = (): boolean => this.bridge.isOn && this.bridge.client === client
      if (!stillConnected()) throw new Error('bridge changed')
      const preview = await client.request<ConfigSyncSummary>('config.preview', options)
      if (!preview.changed) {
        await vscode.window.showInformationMessage('DSH: no configuration changes to import.', { modal: true, detail: configSyncPreviewText(preview, options) })
        return
      }
      const confirm = await vscode.window.showWarningMessage('DSH: Import Web configuration?', {
        modal: true, detail: configSyncPreviewText(preview, options),
      }, 'Import')
      if (confirm !== 'Import') return
      // Never apply a reviewed revision to a replacement bridge instance.
      if (!stillConnected()) throw new Error('bridge changed')
      const result = await client.request<ConfigSyncSummary>('config.import', { ...options, revision: preview.revision })
      await vscode.window.showInformationMessage(result.changed ? 'DSH: Web configuration imported.' : 'DSH: no configuration changes to import.', {
        modal: true,
        detail: [
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
