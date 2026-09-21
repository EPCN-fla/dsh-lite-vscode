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
  icon: string
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

/** Filter by the text typed so far: matches the English name or the label. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter(c => c.name.toLowerCase().includes(q) || c.label.includes(query.trim()))
}
