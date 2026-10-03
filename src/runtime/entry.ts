import type { HotBridge } from './hot-types'
import { hot, setHot } from './lifecycle'
import { mountRuntime } from './mount'
import type { RuntimeConfig } from './types'
import { initializeVersions } from './versions'
export { reportVersion } from './versions'

let currentConfig: RuntimeConfig | undefined
let runtime: ReturnType<typeof mountRuntime> | undefined
export function mountDomino(config: RuntimeConfig) {
  if (document.querySelector('[data-domino-host]')) return
  currentConfig = config
  runtime = mountRuntime(config, hot?.data.memory)
}
function stop() {
  runtime?.dispose()
  window.removeEventListener('pagehide', stop)
}
export function initializeRuntime(context?: HotBridge) {
  setHot(context)
  initializeVersions(hot)
  window.addEventListener('pagehide', stop)
  if (hot) {
    hot.dispose((data) => {
      data.config = currentConfig
      data.memory = runtime?.snapshot()
      stop()
    })
    // HTML injection runs once; self-accepted runtime updates remount themselves.
    if (hot.data.config) mountDomino(hot.data.config)
  }
}
