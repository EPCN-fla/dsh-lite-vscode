/** Shared, secret-free contracts for profile configuration imports. */

export interface ConfigSyncOptions {
  models: boolean
  presets: boolean
  overwrite: boolean
}

export interface ConfigSyncSummary {
  /** Source profile name; `web` remains the default but is no longer required. */
  source: string
  /** Connected target profile name. */
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

export interface ProfileImportRequest extends ConfigSyncOptions {
  operation: 'preview' | 'import'
  source: string
  target: string
  revision?: string
}

export type ProfileImportHostResult =
  | { ok: true; summary: ConfigSyncSummary }
  | { ok: false; code: string; packages?: string[] }

/** Stable error codes cross the host boundary without YAML or credential text. */
export class ProfileImportError extends Error {
  constructor(readonly code: string, readonly packages: string[] = []) {
    super(code)
  }
}

export interface ConfigSyncTransport {
  probeSource(source: string): Promise<boolean>
  preview(source: string, target: string, options: ConfigSyncOptions): Promise<ConfigSyncSummary>
  import(source: string, target: string, options: ConfigSyncOptions, revision: string): Promise<ConfigSyncSummary>
}
