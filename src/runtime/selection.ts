import { STYLE_KEYS } from '../core/protocol'
import type { VisualContext } from '../core/types'
import type { RuntimeConfig } from './types'
import type { RuntimeStore } from './store'

export function createSelection(config: RuntimeConfig, host: HTMLElement, store: RuntimeStore) {
  let selected: Element | null = null
  let hovered: Element | null = null
  let pointer: { x: number; y: number } | null = null
  let frame = 0
  let stopped = false
  const own = (event: Event) => event.composedPath().includes(host)
  const pageElement = (element: Element | null) => element && element !== document.documentElement && element !== document.body && !host.contains(element) ? element : null
  const draw = () => {
    const state = store.getSnapshot()
    const element = state.picking ? hovered : selected
    if (!state.panelOpen || !element?.isConnected || (!state.picking && state.stale)) { store.update({ highlight: null }); return }
    const { x, y, width, height } = element.getBoundingClientRect()
    store.update({ highlight: { x, y, width, height } })
  }
  const scheduleDraw = () => {
    if (!frame && !stopped) frame = requestAnimationFrame(() => { frame = 0; draw() })
  }
  const focus = () => store.update({ focusRequest: store.getSnapshot().focusRequest + 1 })
  const setPicking = (picking: boolean) => {
    hovered = null
    store.update({ picking, panelOpen: true, notice: picking ? '移动鼠标查看目标，点击固定。Esc 退出。' : '' })
    draw()
  }
  const select = (element: Element) => {
    const marked = element.closest('[data-va-id]')
    selected = marked ?? element
    const computed = getComputedStyle(selected)
    const { x, y, width, height } = selected.getBoundingClientRect()
    const styles: Record<string, string> = {}
    for (const key of STYLE_KEYS) styles[key] = computed[key].slice(0, 200)
    const context: VisualContext = {
      sourceId: marked?.getAttribute('data-va-id') ?? '', instruction: '', scope: 'auto',
      locator: selected === element ? 'exact' : 'ancestor', route: location.pathname,
      element: { tagName: selected.tagName.toLowerCase(), text: selected.matches('input,textarea,[contenteditable]') ? '' : (selected.textContent ?? '').trim().slice(0, 500), rect: { x, y, width, height }, styles },
    }
    store.update({ context, stale: false })
    setPicking(false)
    focus()
  }
  const openPanel = () => {
    // Hit-test before React opens a panel that could cover the target.
    const elements = pointer ? null : document.querySelectorAll(':hover')
    const element = pageElement(pointer ? document.elementFromPoint(pointer.x, pointer.y) : elements!.item(elements!.length - 1))
    if (element) select(element)
    else { setPicking(false); focus() }
  }
  const closePanel = () => {
    hovered = null
    store.update({ picking: false, panelOpen: false, highlight: null, notice: '' })
    if (host.shadowRoot?.activeElement instanceof HTMLElement) host.shadowRoot.activeElement.blur()
  }
  const move = (event: MouseEvent) => {
    if (!own(event)) pointer = { x: event.clientX, y: event.clientY }
    if (store.getSnapshot().picking) {
      hovered = own(event) ? null : pageElement(document.elementFromPoint(event.clientX, event.clientY))
      scheduleDraw()
    }
  }
  const leave = (event: MouseEvent) => {
    if (event.relatedTarget !== null) return
    pointer = null; hovered = null; scheduleDraw()
  }
  const click = (event: MouseEvent) => {
    if (!store.getSnapshot().picking || own(event)) return
    event.preventDefault(); event.stopImmediatePropagation()
    const element = pageElement(document.elementFromPoint(event.clientX, event.clientY))
    if (element) select(element)
  }
  const pointerDown = (event: PointerEvent) => {
    if (store.getSnapshot().picking && !own(event)) { event.preventDefault(); event.stopImmediatePropagation() }
  }
  const key = (event: KeyboardEvent) => {
    const state = store.getSnapshot()
    // An open combobox handles Escape locally before the panel handles a second Escape.
    if (event.key === 'Escape' && own(event) && event.composedPath().some(node => node instanceof HTMLElement && node.matches('[role="combobox"][aria-expanded="true"]'))) return
    if (event.key === 'Escape') { if (state.picking) setPicking(false); else closePanel(); return }
    if (event.isComposing || event.repeat || event.defaultPrevented || event.composedPath().some(node => node instanceof HTMLElement && (node.matches('input,textarea,select,[role="combobox"]') || (!state.picking && node.matches('button,[role="button"]')) || node.isContentEditable))) return
    const matches = config.shortcuts.some(combo => {
      const parts = combo.toLowerCase().split('+').map(part => part.trim()).filter(Boolean)
      const last = parts.at(-1)
      return !!last && (last === 'space' ? event.code === 'Space' : event.key.toLowerCase() === last)
        && event.altKey === parts.includes('alt') && event.ctrlKey === parts.includes('ctrl')
        && event.metaKey === parts.includes('meta') && event.shiftKey === parts.includes('shift')
    })
    if (matches) { event.preventDefault(); if (state.picking || !state.panelOpen) openPanel() }
  }
  const observer = new MutationObserver(() => {
    const context = store.getSnapshot().context
    if (selected && context && (!selected.isConnected || (context.sourceId && selected.getAttribute('data-va-id') !== context.sourceId))) {
      store.update({ stale: true }); draw()
    }
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-va-id'] })
  document.addEventListener('mousemove', move, true)
  document.addEventListener('mouseout', leave, true)
  document.addEventListener('click', click, true)
  document.addEventListener('pointerdown', pointerDown, true)
  document.addEventListener('keydown', key, true)
  window.addEventListener('scroll', scheduleDraw, true)
  window.addEventListener('resize', scheduleDraw)
  return {
    openPanel, closePanel, setPicking,
    stop() {
      stopped = true; observer.disconnect(); cancelAnimationFrame(frame)
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('mouseout', leave, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('scroll', scheduleDraw, true)
      window.removeEventListener('resize', scheduleDraw)
    },
  }
}
