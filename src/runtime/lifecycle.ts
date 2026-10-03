import type { HotBridge } from './hot-types'

export let hot: HotBridge | undefined
export function setHot(context?: HotBridge) {
  hot = context
}
