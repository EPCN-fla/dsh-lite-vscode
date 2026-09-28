/** Minimal vscode API mock for headless harness runs (tests only). */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

export class Disposable {
  constructor(private fn?: () => void) {}
  dispose(): void { this.fn?.() }
  static from(...ds: { dispose(): void }[]): Disposable { return new Disposable(() => ds.forEach(d => d.dispose())) }
}

export class EventEmitter<T> {
  private listeners = new Set<(e: T) => void>()
  readonly event = (fn: (e: T) => void): Disposable => {
    this.listeners.add(fn)
    return new Disposable(() => this.listeners.delete(fn))
  }
  fire(e: T): void { for (const fn of [...this.listeners]) fn(e) }
  dispose(): void { this.listeners.clear() }
}

export interface Uri { scheme: string; fsPath: string; path: string }
export const Uri = {
  file(p: string): Uri { return { scheme: 'file', fsPath: p, path: p } },
  parse(s: string): Uri { const u = s.replace(/^file:\/\//, ''); return { scheme: 'file', fsPath: u, path: u } },
  joinPath(base: Uri, ...segs: string[]): Uri { return Uri.file(path.join(base.fsPath, ...segs)) },
}

class Memento {
  private map = new Map<string, unknown>()
  get<T>(key: string, def?: T): T { return (this.map.has(key) ? this.map.get(key) : def) as T }
  async update(key: string, value: unknown): Promise<void> { if (value === undefined) this.map.delete(key); else this.map.set(key, value) }
}

const configValues: Record<string, unknown> = {
  'dsh.profile': 'acp-vscode',
  'dsh.command': `node ${process.env.HOME}/deepseek-harness/apps/cli/lib/bin.js`,
  'dsh.runtime': 'auto',
  'dsh.autoAttachActiveFile': false,
}

export const workspace = {
  workspaceFolders: [{ uri: Uri.file(process.env.SMOKE_CWD ?? process.cwd()), name: 'ws', index: 0 }],
  getConfiguration: (section: string) => ({
    get: <T>(key: string, def?: T): T => (configValues[`${section}.${key}`] ?? def) as T,
    update: async (key: string, value: unknown) => { configValues[`${section}.${key}`] = value },
  }),
  fs: {
    readFile: async (u: Uri) => new Uint8Array(await fsp.readFile(u.fsPath)),
    writeFile: async (u: Uri, data: Uint8Array) => { await fsp.mkdir(path.dirname(u.fsPath), { recursive: true }); await fsp.writeFile(u.fsPath, data) },
    delete: async (u: Uri) => { await fsp.rm(u.fsPath, { force: true }) },
    createDirectory: async (u: Uri) => { await fsp.mkdir(u.fsPath, { recursive: true }) },
    stat: async (u: Uri) => { const st = await fsp.stat(u.fsPath); return { type: st.isDirectory() ? 2 : 1, mtime: st.mtimeMs, size: st.size, ctime: st.ctimeMs } },
  },
  onDidChangeConfiguration: () => new Disposable(),
  onDidChangeWorkspaceFolders: () => new Disposable(),
  createFileSystemWatcher: () => ({ onDidCreate: () => new Disposable(), onDidChange: () => new Disposable(), onDidDelete: () => new Disposable(), dispose: () => {} }),
  findFiles: async () => [],
  asRelativePath: (u: Uri) => path.basename(u.fsPath),
  openTextDocument: async () => { throw new Error('not implemented') },
}

export const window = {
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showQuickPick: async () => undefined,
  showOpenDialog: async () => undefined,
  setStatusBarMessage: () => new Disposable(),
  showTextDocument: async () => undefined,
  activeTextEditor: undefined,
  tabGroups: { all: [] },
  createStatusBarItem: () => ({ show: () => {}, hide: () => {}, dispose: () => {}, text: '', tooltip: '', command: '' }),
  createWebviewPanel: () => { throw new Error('not implemented') },
  registerWebviewViewProvider: () => new Disposable(),
  createOutputChannel: (name: string) => ({
    name,
    appendLine: (l: string) => console.log(`[out:${name}]`, l),
    append: (l: string) => process.stdout.write(l),
    show: () => {}, clear: () => {}, dispose: () => {},
  }),
}

export const commands = { executeCommand: async () => undefined, registerCommand: () => new Disposable() }
export const env = { remoteName: undefined as string | undefined }
export const extensions = { getExtension: () => undefined }
export const StatusBarAlignment = { Right: 2, Left: 1 }
export const ViewColumn = { One: 1, Two: 2 }
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 }
export const ProgressLocation = { Notification: 15 }
export const FileType = { File: 1, Directory: 2 }
export { Memento }
export class RelativePattern {
  constructor(public base: unknown, public pattern: string) {}
}
