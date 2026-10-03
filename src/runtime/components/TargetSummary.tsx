import type { RuntimeState } from '../types'
import SpotlightCard from '../vendor/react-bits/SpotlightCard'

export function TargetSummary({ context, stale }: Pick<RuntimeState, 'context' | 'stale'>) {
  const text = stale ? '选中元素的源码或 DOM 已更新，请重新选择。'
    : !context ? '点击“选择/切换元素”，再点击页面上的目标。'
    : `${!context.sourceId ? '未找到源码标记，无法定位源码' : context.locator === 'ancestor' ? '定位到带标记的父元素' : '定位到原生 JSX 节点'}${context.element.text ? ` · ${context.element.text.slice(0, 40)}` : ''}`
  return <SpotlightCard className="target" spotlightColor="rgba(167, 139, 250, 0.16)">
    <span className="target-chip" hidden={!context}>{context?.element.tagName}</span>
    <span className="target-text">{text}</span>
  </SpotlightCard>
}
