/** Slash-command menu model for the composer (Web-UI style).
 *  dsh exposes no commands over ACP (they live in the TUI/Web interaction
 *  layer), so the menu is built from actions the extension itself can run. */
export interface SlashCommand {
  /** Command name typed after "/" (e.g. "model"). */
  name: string
  /** Display label (e.g. "模型"). */
  label: string
  /** One-line description shown on the right. */
  description: string
  /** Menu group, rendered with a section header (mirrors the Web UI). */
  section: '指令' | '技能'
  /** local: handled by the extension; native: run via bridge command.run;
   *  skill: sent as a prompt asking the model to invoke the skill. */
  run: 'local' | 'native' | 'skill'
  /** Native commands only: input hint — picking fills `/name ` for arguments. */
  hint?: string
}

/** A manually typed "/name [args]" line resolved against the known commands. */
export type SlashLine = { kind: 'native'; line: string } | { kind: 'local'; cmd: SlashCommand }

/**
 * Resolve a typed "/name [args]" line. Native commands accept arguments (the
 * line is executed verbatim); local commands only intercept the bare "/name"
 * form (anything with arguments falls through to a normal prompt).
 */
export function findSlashCommand(commands: SlashCommand[], input: string): SlashLine | undefined {
  const m = /^\/(\S+)([\s\S]*)$/.exec(input.trim())
  if (!m) return undefined
  const name = m[1].toLowerCase()
  const rest = m[2].trim()
  const cmd = commands.find(c => c.name.toLowerCase() === name)
  if (!cmd) return undefined
  if (cmd.run === 'native') return { kind: 'native', line: `/${cmd.name}${rest ? ` ${rest}` : ''}` }
  if (rest) return undefined
  return { kind: 'local', cmd }
}

/** Chinese labels/descriptions for known native dsh commands (Web-UI parity). */
export const NATIVE_COMMAND_ZH: Record<string, { label: string; description: string }> = {
  compact: { label: '压缩', description: '压缩以上对话内容' },
  plan: { label: '计划', description: '进入或退出计划模式' },
  goal: { label: '目标', description: '设置或查看长期任务目标' },
  permission: { label: '权限', description: '切换权限预设（沙箱模式与审批策略）' },
  export: { label: '下载日志', description: '将当前会话内容导出为 ZIP' },
}

/** Native commands never offered in the extension's slash menu. */
export const NATIVE_COMMAND_BLOCKLIST: ReadonlySet<string> = new Set(['feedback'])

/** Filter by the text typed so far: matches the English name or the label. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter(c => c.name.toLowerCase().includes(q) || c.label.includes(query.trim()))
}
