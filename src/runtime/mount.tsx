import { createRoot } from 'react-dom/client'

import { App } from './App'
import { createController } from './controller'
import type { RuntimeMemory } from './controller'
import type { RuntimeConfig } from './types'

import styles from './styles.css?inline'
import glideStyles from './vendor/react-bits/GlideSelect.css?inline'
import spotlightStyles from './vendor/react-bits/SpotlightCard.css?inline'

export function mountRuntime(config: RuntimeConfig, memory?: RuntimeMemory) {
  const host = document.createElement('div')
  host.setAttribute('data-domino-host', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `${spotlightStyles}\n${glideStyles}\n${styles}`
  const container = document.createElement('div')
  shadow.append(style, container)
  document.documentElement.append(host)
  const controller = createController(config, host, memory)
  const root = createRoot(container)
  root.render(<App controller={controller} />)
  controller.start()
  let disposed = false
  return {
    snapshot: controller.snapshot,
    dispose() {
      if (disposed) return
      disposed = true
      controller.stop()
      root.unmount()
      host.remove()
    },
  }
}
