import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { relaunch as tauriRelaunch } from '@tauri-apps/plugin-process'

type ElectronBridge = {
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>
  relaunch: () => Promise<void>
}

declare global {
  interface Window {
    __BROWSERSAVING_ELECTRON__?: ElectronBridge
  }
}

export function isTauri() {
  return typeof window !== 'undefined' && ('__TAURI__' in window || '__TAURI_INTERNALS__' in window)
}

export function isElectron() {
  return typeof window !== 'undefined' && !!window.__BROWSERSAVING_ELECTRON__
}

export function isDesktopApp() {
  return isTauri() || isElectron()
}

export async function desktopInvoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri()) {
    return tauriInvoke<T>(command, args)
  }
  if (isElectron()) {
    return window.__BROWSERSAVING_ELECTRON__!.invoke<T>(command, args)
  }
  throw new Error('Desktop app required')
}

export async function desktopRelaunch(): Promise<void> {
  if (isTauri()) {
    await tauriRelaunch()
    return
  }
  if (isElectron()) {
    await window.__BROWSERSAVING_ELECTRON__!.relaunch()
    return
  }
  throw new Error('Desktop app required')
}
