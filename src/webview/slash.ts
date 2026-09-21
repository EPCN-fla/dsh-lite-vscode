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
}

/** Filter by the text typed so far: matches the English name or the label. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  return commands.filter(c => c.name.toLowerCase().includes(q) || c.label.includes(query.trim()))
}
