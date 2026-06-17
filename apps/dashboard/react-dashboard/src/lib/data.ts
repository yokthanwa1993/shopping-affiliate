// Loose, defensive parsing helpers shared by the read-only React pages. These
// mirror the isRecord/safeString/pick/safeNumber/collect helpers each Svelte
// panel hand-rolled (e.g. GalleryPanel, ProcessingPanel) so the migrated pages
// tolerate the same loosely-typed worker responses without faking data.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function safeString(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

export function safeNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

// First non-empty string value among `keys`, else `fallback`.
export function pick(record: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const k of keys) {
    const v = safeString(record[k])
    if (v) return v
  }
  return fallback
}

// Concatenate every array found under any of `keys` on a payload object.
export function collect(payload: unknown, keys: string[]): unknown[] {
  const out: unknown[] = []
  if (!isRecord(payload)) return out
  for (const k of keys) {
    const c = payload[k]
    if (Array.isArray(c)) out.push(...c)
  }
  return out
}
