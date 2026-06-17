// Formatting helpers mirroring apps/dashboard/src/lib/api.ts so the React
// preview renders dates/views identically to the live Astro/Svelte dashboard.

export function formatThaiDateTime(value: string | null | undefined): string {
  if (!value) return ''
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  const hasTz = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed)
  const parseable = hasTz ? trimmed : trimmed.replace(' ', 'T') + 'Z'
  const d = new Date(parseable)
  if (Number.isNaN(d.getTime())) return trimmed
  return d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
}

export function formatCompactViews(value: number | null | undefined): string {
  const n = typeof value === 'number' ? value : 0
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

// Today's date in Asia/Bangkok as YYYY-MM-DD, mirroring
// apps/dashboard/src/lib/api.ts:todayBangkokDate — used as the History default.
export function todayBangkokDate(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(new Date())
}
