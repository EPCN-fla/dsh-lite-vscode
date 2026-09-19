/**
 * Tracks files changed by the agent per session. Three complementary channels:
 *
 *   1. FileSystemWatcher (primary, repo-independent): file writes that occur while
 *      a prompt is in flight are attributed to that session. Works across WSL/Windows
 *      because the watcher lives wherever VS Code's workspace does.
 *   2. ACP tool_call diff payloads (when the agent emits them).
 *   3. `git status` at prompt settle — only when the workspace is a git repo;
 *      files already dirty at session start are excluded.
 *
 * Diff view: `dsh-baseline://` serves `git show HEAD:<file>` (empty for untracked
 * files / non-repo workspaces); "modified" files without git fall back to opening
 * the file directly.
 */
import * as vscode from 'vscode'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { extractDiffPaths, parsePorcelainZ, isIgnoredPath } from '../shared/changes.js'
import type { Launcher } from '../launcher/types.js'

const execFileP = promisify(execFile)

export interface ChangedFile { path: string; label: string; kind: 'created' | 'modified' }

export class ChangedFilesTracker implements vscode.Disposable {
  private perSession = new Map<string, Map<string, ChangedFile['kind']>>()
  private baselineDirty = new Map<string, Set<string>>()
  private busySessions = new Set<string>()
  private isGitRepo?: boolean
  private watcher?: vscode.FileSystemWatcher
  private readonly _onDidChange = new vscode.EventEmitter<{ sessionId: string; files: ChangedFile[] }>()
  readonly onDidChange = this._onDidChange.event

  constructor(
    private getLauncher: () => Launcher,
    private out: vscode.OutputChannel,
  ) {}

  // ---------- watcher channel ----------

  private ensureWatcher(): void {
    if (this.watcher) return
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) return
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'))
    const onCreate = (uri: vscode.Uri): void => this.record(uri.fsPath, 'created')
    const onChange = (uri: vscode.Uri): void => this.record(uri.fsPath, 'modified')
    this.watcher.onDidCreate(onCreate)
    this.watcher.onDidChange(onChange)
  }

  private record(fsPath: string, kind: ChangedFile['kind']): void {
    if (this.busySessions.size === 0 || isIgnoredPath(fsPath)) return
    for (const id of this.busySessions) {
      const map = this.perSession.get(id)
      if (!map) continue
      if (map.get(fsPath) !== 'created') map.set(fsPath, kind)
      this.fire(id)
    }
  }

  promptStarted(sessionId: string): void {
    this.ensureWatcher()
    this.busySessions.add(sessionId)
  }

  async promptSettled(sessionId: string): Promise<void> {
    this.busySessions.delete(sessionId)
    await this.refreshFromGit(sessionId)
  }

  // ---------- session lifecycle ----------

  async startSession(sessionId: string): Promise<void> {
    this.perSession.set(sessionId, new Map())
    if (await this.gitRepo()) {
      const dirty = parsePorcelainZ(await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']))
      this.baselineDirty.set(sessionId, new Set(dirty.map(e => path.resolve(this.wsRoot()!, e.path))))
    }
  }

  clear(sessionId: string): void {
    this.perSession.delete(sessionId)
    this.baselineDirty.delete(sessionId)
    this.busySessions.delete(sessionId)
  }

  // ---------- ACP diff-payload channel ----------

  async ingestUpdate(sessionId: string, update: SessionUpdate): Promise<void> {
    const paths = extractDiffPaths(update)
    if (paths.length === 0) return
    const map = this.perSession.get(sessionId)
    if (!map) return
    const mapper = this.getLauncher().paths
    for (const p of paths) {
      const hostPath = await mapper.fromDsh(p).catch(() => undefined)
      if (hostPath && !map.has(hostPath)) map.set(hostPath, 'modified')
    }
    this.fire(sessionId)
  }

  // ---------- git channel ----------

  private wsRoot(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  private async gitRepo(): Promise<boolean> {
    if (this.isGitRepo !== undefined) return this.isGitRepo
    const out = await this.git(['rev-parse', '--is-inside-work-tree'])
    this.isGitRepo = out.trim() === 'true'
    return this.isGitRepo
  }

  private async git(args: string[]): Promise<string> {
    const cwd = this.wsRoot()
    if (!cwd) return ''
    try {
      return (await execFileP('git', args, { cwd, timeout: 15_000 })).stdout
    } catch {
      return ''
    }
  }

  private async refreshFromGit(sessionId: string): Promise<void> {
    if (!await this.gitRepo()) return
    const map = this.perSession.get(sessionId)
    const baseline = this.baselineDirty.get(sessionId)
    if (!map || !baseline) return
    const root = this.wsRoot()
    if (!root) return
    const now = parsePorcelainZ(await this.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']))
    for (const e of now) {
      const abs = path.resolve(root, e.path)
      if (baseline.has(abs) || isIgnoredPath(abs)) continue
      if (map.get(abs) !== 'created') map.set(abs, e.created ? 'created' : 'modified')
    }
    this.fire(sessionId)
  }

  // ---------- queries & diff ----------

  filesFor(sessionId: string): ChangedFile[] {
    const map = this.perSession.get(sessionId)
    if (!map) return []
    return [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([p, kind]) => ({ path: p, label: vscode.workspace.asRelativePath(p), kind }))
  }

  async openDiff(file: ChangedFile): Promise<void> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(file.path))
    } catch {
      void vscode.window.showInformationMessage(`File no longer exists: ${file.label}`)
      return
    }
    if (file.kind === 'created' || await this.gitRepo()) {
      const root = this.wsRoot()!
      const rel = path.relative(root, file.path).split(path.sep).join('/')
      const left = vscode.Uri.parse(`dsh-baseline:///${rel.split('/').map(encodeURIComponent).join('/')}`)
      await vscode.commands.executeCommand('vscode.diff', left, vscode.Uri.file(file.path), `${file.label} (DSH changes)`)
    } else {
      // Modified file without git: no baseline available — just open it.
      await vscode.window.showTextDocument(vscode.Uri.file(file.path))
      void vscode.window.setStatusBarMessage('DSH: run `git init` in the workspace to enable before/after diffs.', 5000)
    }
  }

  dispose(): void { this.watcher?.dispose() }

  private fire(sessionId: string): void {
    this._onDidChange.fire({ sessionId, files: this.filesFor(sessionId) })
  }
}

/** TextDocumentContentProvider serving `git show HEAD:<rel>` for the left diff side. */
export class BaselineContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private out: vscode.OutputChannel) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) return ''
    const rel = decodeURIComponent(uri.path.replace(/^\//, ''))
    try {
      const r = await execFileP('git', ['show', `HEAD:${rel}`], { cwd: root, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 })
      return r.stdout
    } catch {
      return '' // untracked / no repo: empty baseline
    }
  }
}
