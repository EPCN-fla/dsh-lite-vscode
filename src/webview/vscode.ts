/** Typed wrapper around acquireVsCodeApi. */
import type { ToHost } from '../shared/messages.js'

interface VsCodeApi { postMessage(m: ToHost): void; getState(): unknown; setState(s: unknown): void }

let api: VsCodeApi | undefined
export function vscodeApi(): VsCodeApi {
  if (!api) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api = (window as any).acquireVsCodeApi()
  }
  return api!
}
export const post = (m: ToHost): void => vscodeApi().postMessage(m)
