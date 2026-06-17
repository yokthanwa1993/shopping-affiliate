// Tiny HTTP helpers shared between the raw Worker fetch handler (worker.ts) and
// the Hono-based API slices under src/server/*. Kept dependency-free so both the
// legacy entrypoint and the new Hono apps can use the exact same primitives —
// no behavior change, just a shared home.

export function jsonResponse(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders)
  headers.set('Content-Type', 'application/json; charset=utf-8')
  headers.set('Cache-Control', 'no-store')
  return new Response(JSON.stringify(data), { status, headers })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

export function pickString(source: unknown, keys: string[]): string {
  if (!isRecord(source)) return ''
  for (const key of keys) {
    const value = safeString(source[key])
    if (value) return value
  }
  return ''
}
