/** Compact context-usage formatting for the status bar. */
export function formatUsage(used: number, size: number): string {
  if (size > 0) return `${Math.round((used / size) * 100)}% · ${abbr(used)}/${abbr(size)}`
  return `${abbr(used)} tok`
}

function abbr(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(n)
}
