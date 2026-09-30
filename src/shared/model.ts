/** Model picker helpers shared by host (status bar) and webview (select). */
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

export interface FlatOption { value: string; label: string; group?: string; description?: string }

/** Rail/menu option: adds disabled + reason hint over the plain option. */
export interface SelectOption extends FlatOption { disabled?: boolean; hint?: string }

export function findModelOption(options: SessionConfigOption[]): SessionConfigOption | undefined {
  return options.find(o => o.category === 'model' || o.id === 'model')
}

export function flattenOptions(opt: SessionConfigOption): FlatOption[] {
  if (opt.type !== 'select') return []
  const label = (name: string): string => (name === 'Provider default' ? 'Default' : name)
  return opt.options.flatMap(o =>
    'options' in o
      ? o.options.map(sub => ({ value: sub.value, label: label(sub.name), group: o.name, description: sub.description ?? undefined }))
      : [{ value: o.value, label: label(o.name), description: o.description ?? undefined }],
  )
}

export function friendlyModelName(options: SessionConfigOption[]): string | undefined {
  const model = findModelOption(options)
  if (!model || model.type !== 'select') return undefined
  return flattenOptions(model).find(f => f.value === model.currentValue)?.label
}

/** dsh's ACP server uses '' for the "Provider default" reasoning-effort row. */
export const PROVIDER_DEFAULT_EFFORT_VALUE = ''

/** Effort ranks for "highest" fallback; unknown ids fall back to list order. */
const EFFORT_RANK: Record<string, number> = { off: 0, none: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 }

export function effortOptionsWithoutDefault<T extends { value: string }>(options: T[]): T[] {
  return options.filter(o => o.value !== PROVIDER_DEFAULT_EFFORT_VALUE)
}

/**
 * Pick the effort to pin: the model's configured defaultEffort when present,
 * otherwise the highest declared level. Returns undefined when no choice exists.
 */
export function chooseEffort(options: { value: string }[], configuredDefault?: string): string | undefined {
  const opts = effortOptionsWithoutDefault(options)
  if (opts.length === 0) return undefined
  if (configuredDefault && opts.some(o => o.value === configuredDefault)) return configuredDefault
  return opts.reduce((a, b) => ((EFFORT_RANK[b.value] ?? opts.indexOf(b)) > (EFFORT_RANK[a.value] ?? opts.indexOf(a)) ? b : a)).value
}

/** Extract the model id from an ACP model config value ('["provider","model"]'). */
export function modelIdOf(configValue: string): string | undefined {
  try {
    const v = JSON.parse(configValue)
    return Array.isArray(v) && typeof v[1] === 'string' ? v[1] : undefined
  } catch { return undefined }
}

/**
 * Collect model id → defaultEffort from a parsed dsh config document. Handles
 * both historical shapes: the pre-0.1.7 global settings.yaml (a section-keyed
 * map) and the per-profile cordis.patch.yml (a patch-entry list, provider
 * config nested under `config` or inside `insert` rows). Any object carrying a
 * `providers` map contributes; later documents override earlier ones per id.
 */
export function collectEffortDefaults(doc: unknown, into = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(doc)) {
    for (const item of doc) collectEffortDefaults(item, into)
    return into
  }
  if (doc && typeof doc === 'object') {
    const rec = doc as Record<string, unknown>
    const providers = rec.providers
    if (providers && typeof providers === 'object') {
      for (const p of Object.values(providers as Record<string, { models?: { id?: unknown; defaultEffort?: unknown }[] }>)) {
        for (const m of p?.models ?? []) {
          if (typeof m?.id === 'string' && typeof m.defaultEffort === 'string') into.set(m.id, m.defaultEffort)
        }
      }
    }
    for (const [k, v] of Object.entries(rec)) {
      if (k !== 'providers') collectEffortDefaults(v, into)
    }
  }
  return into
}
