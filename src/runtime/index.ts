import { mountRuntime } from './mount'
import type { RuntimeConfig } from './types'
export { reportVersion } from './versions'

let currentConfig: RuntimeConfig | undefined
let runtime: ReturnType<typeof mountRuntime> | undefined
export function mountDomino(config: RuntimeConfig) {
  if (document.querySelector('[data-domino-host]')) return
  currentConfig = config
  runtime = mountRuntime(config, import.meta.hot?.data.memory)
}
function stop() { runtime?.dispose(); window.removeEventListener('pagehide', stop) }
window.addEventListener('pagehide', stop)
if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(data => {
    data.config = currentConfig
    data.memory = runtime?.snapshot()
    stop()
  })
  // HTML injection runs once; self-accepted runtime updates remount themselves.
  if (import.meta.hot.data.config) mountDomino(import.meta.hot.data.config)
}
