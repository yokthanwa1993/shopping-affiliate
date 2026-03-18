type RuntimeConfig = {
  serverUrl?: string
  apiUrl?: string
  commentTokenServiceUrl?: string
  remoteLauncherUrl?: string
}

declare global {
  interface Window {
    __BROWSERSAVING_RUNTIME_CONFIG__?: RuntimeConfig
  }
}

const runtimeConfig = typeof window !== 'undefined'
  ? (window.__BROWSERSAVING_RUNTIME_CONFIG__ || {})
  : {}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const SERVER_URL =
  readString(runtimeConfig.serverUrl) ||
  readString(import.meta.env.VITE_SERVER_URL) ||
  'https://browsersaving-worker.yokthanwa1993-bc9.workers.dev'

export const BROWSERSAVING_API_URL =
  readString(runtimeConfig.apiUrl) ||
  readString(import.meta.env.VITE_BROWSERSAVING_API_URL) ||
  'https://browsersaving-api.lslly.com'

export const COMMENT_TOKEN_SERVICE_URL =
  readString(runtimeConfig.commentTokenServiceUrl) ||
  readString(import.meta.env.VITE_COMMENT_TOKEN_SERVICE_URL) ||
  'http://100.82.152.81:3457/token'

export const REMOTE_LAUNCHER_URL =
  readString(runtimeConfig.remoteLauncherUrl) ||
  readString(import.meta.env.VITE_REMOTE_LAUNCHER_URL)
