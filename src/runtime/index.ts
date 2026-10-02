import type { Task, VisualContext, Diagnostic } from '../core/types'
import { TERMINAL } from '../core/types'
import { STYLE_KEYS } from '../core/protocol'

interface RuntimeConfig { token: string; sessionId: string; wsPath: string; shortcuts: string[] }
const versions: Record<string, string> = Object.create(null)
let onVersion: () => void = () => {}
export function reportVersion(file: string, version: string) {
  versions[file] = version
  requestAnimationFrame(() => onVersion())
}

const labels: Record<Task['status'], string> = { queued: '排队中', running: 'Agent 执行中', cancelling: '正在停止', validating: '检查并应用', completed: '已完成', completed_with_issues: '完成但存在问题', failed: '失败', cancelled: '已取消' }
export function mountDomino(config: RuntimeConfig) {
  if (document.querySelector('[data-domino-host]')) return
  const host = document.createElement('div')
  host.setAttribute('data-domino-host', '')
  document.documentElement.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;color:#eef0f5;color-scheme:dark;-webkit-font-smoothing:antialiased;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,"PingFang SC","Hiragino Sans GB","Microsoft YaHei UI","Microsoft YaHei",sans-serif}
    *{box-sizing:border-box}button,input,select{font:inherit;color:inherit}button,select{cursor:pointer}button{border:0;background:none;padding:0}button:disabled{cursor:default}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
    button,select{transition:background .15s ease,border-color .15s ease,box-shadow .15s ease,color .15s ease,transform .12s ease,opacity .15s ease}
    button:focus-visible,select:focus-visible{outline:2px solid rgba(167,139,250,.8);outline-offset:2px}
    ::selection{background:rgba(124,92,255,.45);color:#fff}
    .panel ::-webkit-scrollbar,.progress-body::-webkit-scrollbar{width:8px;height:8px}
    .panel ::-webkit-scrollbar-thumb,.progress-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.16);border-radius:8px;background-clip:content-box;border:2px solid transparent}
    .panel ::-webkit-scrollbar-track,.progress-body::-webkit-scrollbar-track{background:transparent}
    .dock{position:fixed;bottom:20px;right:20px;pointer-events:auto;height:38px;padding:0 15px;display:inline-flex;align-items:center;gap:8px;border-radius:999px;border:1px solid rgba(255,255,255,.1);background:rgba(20,21,28,.72);-webkit-backdrop-filter:blur(18px) saturate(1.4);backdrop-filter:blur(18px) saturate(1.4);color:#d6d9e2;font-weight:600;box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 6px 24px -6px rgba(0,0,0,.5)}.dock:hover{transform:translateY(-1px);border-color:rgba(255,255,255,.2);background:rgba(26,27,36,.78)}.dock:active{transform:none}.dock .gem{color:#a78bfa;font-size:12px;line-height:1}.dock.active{border-color:rgba(139,92,246,.55);box-shadow:inset 0 1px 0 rgba(255,255,255,.07),0 0 0 3px rgba(124,92,255,.16),0 6px 24px -6px rgba(0,0,0,.5)}
    .panel{position:fixed;left:50%;bottom:12vh;transform:translateX(-50%);width:min(640px,calc(100vw - 32px));max-height:80vh;overflow:auto;pointer-events:auto;border-radius:16px;padding:14px 16px 12px;border:1px solid rgba(255,255,255,.09);background:linear-gradient(180deg,rgba(30,32,43,.82),rgba(17,18,25,.86));-webkit-backdrop-filter:blur(22px) saturate(1.5);backdrop-filter:blur(22px) saturate(1.5);box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 6px 20px rgba(0,0,0,.25),0 28px 64px -16px rgba(0,0,0,.55);animation:panel-in .3s cubic-bezier(.21,1.02,.44,1)}.panel[hidden]{display:none}
    @keyframes panel-in{from{opacity:0;transform:translateX(-50%) translateY(14px) scale(.982)}}
    @supports not ((backdrop-filter:blur(4px)) or (-webkit-backdrop-filter:blur(4px))){.panel{background:rgba(19,20,27,.97)}.dock{background:rgba(19,20,27,.95)}}
    .element-row{display:flex;align-items:center;gap:8px}
    .target{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.06)}
    .target-chip{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:1;color:#c9b8ff;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.3);border-radius:6px;padding:4px 6px}.target-chip[hidden]{display:none}
    .target-text{min-width:0;color:#aeb3c2;font-size:12.5px;overflow-wrap:anywhere}
    .ghost{display:inline-flex;align-items:center;gap:6px;flex:none;padding:7px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:#d6d9e2}.ghost:hover:not(:disabled){background:rgba(255,255,255,.09);border-color:rgba(255,255,255,.16)}.ghost:active:not(:disabled){transform:translateY(1px)}.ghost:disabled{opacity:.35}.ghost svg{flex:none}
    .close{flex:none;width:28px;height:28px;display:grid;place-items:center;border-radius:8px;color:#8b90a0;font-size:17px;line-height:1}.close:hover{background:rgba(255,255,255,.08);color:#e6e8ef}
    .progress{margin:12px 0 0;padding:3px;border-radius:12px;background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.06);animation:tray-in .32s cubic-bezier(.21,1.02,.44,1)}.progress[hidden]{display:none}
    @keyframes tray-in{from{opacity:0;transform:translateY(-6px)}}
    .progress-head{display:flex;align-items:center;gap:9px;width:100%;text-align:left;border-radius:9px;padding:8px 10px}.progress-head:hover{background:rgba(255,255,255,.045)}
    .progress-dot{flex:none;width:7px;height:7px;border-radius:50%;background:#8b5cf6;box-shadow:0 0 8px rgba(139,92,246,.9);opacity:0;transition:opacity .25s}.progress.working .progress-dot{opacity:1;animation:breathe 2s ease-in-out infinite}
    @keyframes breathe{50%{opacity:.35;transform:scale(.7)}}
    .progress-label{font-weight:600;font-size:12.5px;color:#dfe2ea}
    .progress.working .progress-label{background:linear-gradient(100deg,#8f95a3 20%,#eef0f5 42%,#eef0f5 54%,#8f95a3 76%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:sweep 1.6s linear infinite}
    @keyframes sweep{from{background-position:160% 0}to{background-position:-60% 0}}
    .progress-caret{margin-left:auto;color:#8b90a0;display:grid;place-items:center;transition:transform .25s cubic-bezier(.21,1.02,.44,1)}.progress.open .progress-caret{transform:rotate(180deg)}
    .progress-fold{display:grid;grid-template-rows:0fr;visibility:hidden;transition:grid-template-rows .3s cubic-bezier(.21,1.02,.44,1),visibility 0s linear .3s}.progress.open .progress-fold{grid-template-rows:1fr;visibility:visible;transition:grid-template-rows .3s cubic-bezier(.21,1.02,.44,1),visibility 0s linear 0s}
    .progress-clip{min-height:0;overflow:hidden}
    .progress-body{padding:2px 10px 9px;overflow:hidden}.progress.open .progress-body{overflow-y:auto;max-height:300px;border-top:1px solid rgba(255,255,255,.06);margin-top:2px;padding-top:6px}
    .row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:8px 0 2px}.task-status{font-size:12.5px;font-weight:600;color:#dfe2ea}
    .history{max-width:55%;height:27px;padding:0 6px;border-radius:7px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.04);color:#c6cad6;font-size:12px}.history:hover{background:rgba(255,255,255,.08)}
    .muted{color:#8b90a0;font-size:11.5px}.source,.page{margin:3px 0}
    .log{white-space:pre-wrap;color:#aab0c0;font-size:12px}
    .error{color:#ff9aa5;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
    .actions{display:flex;gap:7px;flex-wrap:wrap;margin:10px 0}
    .diffs summary{cursor:pointer;margin:9px 0;color:#b9bfcf;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}.diffs summary:hover{color:#e6e8ef}
    .diff{white-space:pre;overflow:auto;max-height:240px;font:11px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:rgba(0,0,0,.34);border:1px solid rgba(255,255,255,.05);padding:10px 12px;border-radius:8px;color:#c3c8d6}
    .input-row{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap}
    #domino-scope{flex:none;height:38px;padding:0 8px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);color:#c6cad6;font-size:12.5px}#domino-scope:hover{background:rgba(255,255,255,.08)}
    #domino-instruction{flex:1 1 160px;min-width:0;height:38px;padding:0 12px;font-size:14px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.28);color:#f2f3f7;transition:border-color .18s ease,box-shadow .18s ease}#domino-instruction::placeholder{color:#787e8f}#domino-instruction:focus{outline:none;border-color:rgba(139,92,246,.65);box-shadow:0 0 0 3px rgba(124,92,255,.18)}
    .submit{display:inline-flex;align-items:center;gap:6px;flex:none;height:38px;padding:0 16px;border-radius:10px;background:#7c5cff;color:#fff;font-weight:600;box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 4px 14px -4px rgba(124,92,255,.5)}.submit:hover:not(:disabled){background:#8a70ff;transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.22),0 6px 18px -4px rgba(124,92,255,.6)}.submit:active:not(:disabled){transform:none}.submit:disabled{background:rgba(124,92,255,.32);box-shadow:none;color:rgba(255,255,255,.7)}
    .notice{margin:10px 0 0;color:#b9a8ff;font-size:12px;overflow-wrap:anywhere}
    .foot{display:flex;justify-content:space-between;gap:12px;margin-top:11px;flex-wrap:wrap}
    .highlight{position:fixed;border:1.5px solid #a78bfa;background:rgba(139,92,246,.14);box-shadow:0 0 0 1px rgba(139,92,246,.25),0 0 28px rgba(139,92,246,.28);pointer-events:none;border-radius:5px;display:none}
    @media (prefers-reduced-motion:reduce){.panel,.dock,.panel *,.dock *{transition:none!important;animation:none!important}}
  </style>
  <div class="highlight"></div>
  <button class="dock" aria-label="打开 domino"><span class="gem" aria-hidden="true">◆</span><span>domino</span></button>
  <section class="panel" role="dialog" aria-label="domino 前端修改" hidden>
    <div class="element-row">
      <div class="target"><span class="target-chip" hidden></span><span class="target-text">点击“选择/切换元素”，再点击页面上的目标。</span></div>
      <button class="ghost pick"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="4.2"/><path d="M8 1v2.4M8 12.6V15M1 8h2.4M12.6 8H15"/></svg><span class="pick-label">选择/切换元素</span></button>
      <button class="close" aria-label="关闭面板">×</button>
    </div>
    <div class="progress" hidden>
      <button class="progress-head" aria-expanded="false" aria-controls="domino-progress-body">
        <span class="progress-dot" aria-hidden="true"></span><span class="progress-label">正在处理中</span>
        <span class="progress-caret" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"/></svg></span>
      </button>
      <div class="progress-fold" id="domino-progress-body"><div class="progress-clip"><div class="progress-body">
        <div class="row"><strong class="task-status"></strong><select class="history" aria-label="历史任务"></select></div>
        <div class="source muted"></div><div class="page muted"></div><div class="log"></div><div class="task-error error"></div>
        <div class="actions"><button class="ghost cancel">取消任务</button><button class="ghost undo">撤销改动</button></div>
        <div class="diffs"></div>
      </div></div></div>
    </div>
    <div class="input-row">
      <select id="domino-scope" aria-label="作用范围"><option value="auto">由 Agent 判断</option><option value="usage">仅当前使用处（意图）</option><option value="component">修改共享组件</option></select>
      <input id="domino-instruction" aria-label="修改要求" maxlength="4000" placeholder="描述修改要求，回车发送" autocomplete="off">
      <button class="submit"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5"/></svg>发送</button>
    </div>
    <div class="notice" role="status"></div><div class="build-error error" role="alert"></div>
    <div class="foot"><small class="muted connection">正在连接开发服务器…</small><small class="muted">源码上下文可能发送至模型服务</small></div>
  </section>`
  const get = <T extends HTMLElement>(selector: string) => shadow.querySelector<T>(selector)!
  const panel = get<HTMLElement>('.panel')
  const panelKey = `domino:${config.sessionId}:panel`
  try { panel.hidden = sessionStorage.getItem(panelKey) !== 'open' } catch { /* Storage may be unavailable. */ }
  const dock = get<HTMLButtonElement>('.dock')
  const syncDock = () => dock.classList.toggle('active', !panel.hidden)
  syncDock()
  const highlight = get<HTMLElement>('.highlight')
  const notice = get<HTMLElement>('.notice')
  const targetChip = get<HTMLElement>('.target-chip')
  const targetText = get<HTMLElement>('.target-text')
  const input = get<HTMLInputElement>('#domino-instruction')
  const scope = get<HTMLSelectElement>('#domino-scope')
  const history = get<HTMLSelectElement>('.history')
  const progress = get<HTMLElement>('.progress')
  const progressHead = get<HTMLButtonElement>('.progress-head')
  const progressLabel = get<HTMLElement>('.progress-label')
  let progressOpen = false
  let lastInstruction = ''
  let picking = false
  let hovered: Element | null = null
  let pointerPosition: { x: number; y: number } | null = null
  let selected: Element | null = null
  let context: VisualContext | null = null
  let stale = false
  let diagnostic: Diagnostic = { ready: false, message: '连接中' }
  let ready = false
  let stopped = false
  let socket: WebSocket | undefined
  let reconnect: ReturnType<typeof setTimeout> | undefined
  let reconnectDelay = 500
  const tasks = new Map<string, Task>()
  const pending = new Map<string, Record<string, unknown>>()
  let activeId: string | undefined
  const own = (event: Event) => event.composedPath().includes(host)
  const say = (message: string) => { notice.textContent = message }
  const updateSubmit = () => {
    get<HTMLButtonElement>('.submit').disabled = !ready || !diagnostic.ready || !context?.sourceId || stale || !input.value.trim() || [...pending.values()].some(request => request.type === 'task.create')
  }
  const send = (message: Record<string, unknown>, retry = false) => {
    if (retry && typeof message.requestId === 'string') pending.set(message.requestId, message)
    if (ready && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    else if (!retry) say('连接已断开，请等待重新连接。')
    updateSubmit()
  }
  const ackPage = () => {
    if (!ready) return
    for (const task of tasks.values()) if (task.status === 'completed' && task.pageUpdate === 'pending' && !task.undone) {
      const sourcePaths = task.changes.filter(change => /\.[cm]?[jt]sx?$/.test(change.path)).map(change => change.path)
      if (sourcePaths.length && sourcePaths.every(path => versions[path])) send({ type: 'task.pageUpdated', taskId: task.id, versions: Object.fromEntries(sourcePaths.map(path => [path, versions[path]])) })
    }
  }
  onVersion = ackPage
  const renderTask = () => {
    const sorted = [...tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
    if (!activeId || !tasks.has(activeId)) activeId = sorted[0]?.id
    history.replaceChildren(...sorted.map(task => { const option = document.createElement('option'); option.value = task.id; option.textContent = `${labels[task.status]} · ${task.instruction.slice(0, 18)}`; return option }))
    history.value = activeId ?? ''
    const task = activeId ? tasks.get(activeId) : undefined
    progress.hidden = !task
    progress.classList.toggle('open', progressOpen)
    progressHead.setAttribute('aria-expanded', String(progressOpen))
    if (!task) return
    const working = !task.undone && !TERMINAL.has(task.status)
    progress.classList.toggle('working', working)
    progressLabel.textContent = working ? '正在处理中' : task.undone ? '已撤销' : labels[task.status]
    get<HTMLElement>('.task-status').textContent = task.undone ? '已撤销' : labels[task.status]
    get<HTMLElement>('.source').textContent = `${task.source.file}:${task.source.start.line} · ${task.applied ? '已应用' : '候选改动'}`
    get<HTMLElement>('.page').textContent = task.pageUpdate === 'received' ? '已收到浏览器模块更新确认，请核对当前页面。' : task.pageUpdate === 'pending' ? '页面更新待确认，请核对界面。' : ''
    const log = get<HTMLElement>('.log')
    log.textContent = task.logs.join('\n')
    log.scrollTop = log.scrollHeight
    get<HTMLElement>('.task-error').textContent = task.error ?? ''
    get<HTMLButtonElement>('.cancel').disabled = TERMINAL.has(task.status) || task.status === 'cancelling' || !ready
    get<HTMLButtonElement>('.undo').disabled = !task.applied || task.undone || !ready || [...tasks.values()].some(item => !TERMINAL.has(item.status))
    get<HTMLElement>('.diffs').replaceChildren(...task.changes.map(change => {
      const details = document.createElement('details')
      const summary = document.createElement('summary'); summary.textContent = change.path
      const pre = document.createElement('pre'); pre.className = 'diff'; pre.textContent = change.patch
      details.append(summary, pre); return details
    }))
  }
  const connect = () => {
    if (stopped) return
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${config.wsPath}`)
    socket.onopen = () => socket!.send(JSON.stringify({ type: 'hello', protocolVersion: 1, token: config.token, sessionId: config.sessionId }))
    socket.onmessage = event => {
      let message: any
      try { message = JSON.parse(event.data) } catch { return }
      if (message.type === 'ready') {
        ready = true; reconnectDelay = 500; diagnostic = message.diagnostic
        get<HTMLElement>('.connection').textContent = diagnostic.message
        for (const task of message.tasks) tasks.set(task.id, task)
        for (const request of pending.values()) send(request)
        renderTask(); updateSubmit(); ackPage()
      } else if (message.type === 'task.snapshot') {
        const task = message.task as Task
        if ((tasks.get(task.id)?.seq ?? -1) > task.seq) return
        tasks.set(task.id, task); renderTask(); ackPage()
      } else if (message.type === 'reply') {
        const request = pending.get(message.requestId)
        pending.delete(message.requestId)
        if (message.error) {
          say(message.error)
          if (request?.type === 'task.create' && lastInstruction && !input.value.trim()) input.value = lastInstruction
        } else if (message.taskId) { activeId = message.taskId; progressOpen = false; say('任务已提交。'); renderTask() }
        lastInstruction = ''
        updateSubmit()
      }
    }
    socket.onclose = event => {
      ready = false; updateSubmit(); renderTask()
      get<HTMLElement>('.connection').textContent = event.code === 1008 ? '连接被拒绝，请刷新页面并检查本地访问地址。' : '连接断开，正在重连…'
      if (!stopped && event.code !== 1008) { reconnect = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(10000, reconnectDelay * 2) }
    }
    socket.onerror = () => {}
  }
  const draw = () => {
    const element = picking ? hovered : selected
    if (!element?.isConnected || (!picking && stale)) { highlight.style.display = 'none'; return }
    const rect = element.getBoundingClientRect()
    Object.assign(highlight.style, { display: 'block', left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }
  let frame = 0
  const scheduleDraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw() }) }
  const setPicking = (value: boolean) => {
    picking = value; hovered = null; panel.hidden = false; syncDock()
    get<HTMLElement>('.pick-label').textContent = picking ? '退出选择' : '选择/切换元素'
    say(picking ? '移动鼠标查看目标，点击固定。Esc 退出。' : '')
    draw()
  }
  const pageElement = (element: Element | null) => element && element !== document.documentElement && element !== document.body && !host.contains(element) ? element : null
  const elementAtPointer = () => {
    if (pointerPosition) return pageElement(document.elementFromPoint(pointerPosition.x, pointerPosition.y))
    const elements = document.querySelectorAll(':hover')
    return pageElement(elements.item(elements.length - 1))
  }
  const select = (element: Element) => {
    const marked = element.closest('[data-va-id]')
    selected = marked ?? element; stale = false
    const style = getComputedStyle(selected)
    const rect = selected.getBoundingClientRect()
    const styles: Record<string, string> = {}
    for (const key of STYLE_KEYS) styles[key] = style[key].slice(0, 200)
    context = { sourceId: marked?.getAttribute('data-va-id') ?? '', instruction: '', scope: 'auto', locator: selected === element ? 'exact' : 'ancestor', route: location.pathname, element: { tagName: selected.tagName.toLowerCase(), text: selected.matches('input,textarea,[contenteditable]') ? '' : (selected.textContent ?? '').trim().slice(0, 500), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles } }
    setPicking(false)
    targetChip.hidden = false
    targetChip.textContent = context.element.tagName
    targetText.textContent = `${!marked ? '未找到源码标记，无法定位源码' : context.locator === 'ancestor' ? '定位到带标记的父元素' : '定位到原生 JSX 节点'}${context.element.text ? ` · ${context.element.text.slice(0, 40)}` : ''}`
    updateSubmit(); input.focus(); draw()
  }
  const openPanel = () => {
    // Resolve before showing the panel: it may cover the element under the pointer.
    const element = elementAtPointer()
    if (element) select(element)
    else { setPicking(false); input.focus() }
  }
  const closePanel = () => {
    setPicking(false); panel.hidden = true; syncDock(); highlight.style.display = 'none'
    if (shadow.activeElement instanceof HTMLElement) shadow.activeElement.blur()
  }
  const move = (event: MouseEvent) => {
    // Keep the last page position when moving onto the dock or editor.
    if (!own(event)) pointerPosition = { x: event.clientX, y: event.clientY }
    if (picking) {
      hovered = own(event) ? null : pageElement(document.elementFromPoint(event.clientX, event.clientY))
      scheduleDraw()
    }
  }
  const leave = (event: MouseEvent) => {
    if (event.relatedTarget !== null) return
    pointerPosition = null; hovered = null; scheduleDraw()
  }
  const click = (event: MouseEvent) => {
    if (!picking || own(event)) return
    event.preventDefault(); event.stopImmediatePropagation()
    const element = document.elementFromPoint(event.clientX, event.clientY)
    if (element) select(element)
  }
  const pointerDown = (event: PointerEvent) => { if (picking && !own(event)) { event.preventDefault(); event.stopImmediatePropagation() } }
  const matchesShortcut = (event: KeyboardEvent) => config.shortcuts.some(combo => {
    const parts = combo.toLowerCase().split('+').map(part => part.trim()).filter(Boolean)
    const last = parts.at(-1)
    if (!last) return false
    const keyMatches = last === 'space' ? event.code === 'Space' : event.key.toLowerCase() === last
    return keyMatches && event.altKey === parts.includes('alt') && event.ctrlKey === parts.includes('ctrl') && event.metaKey === parts.includes('meta') && event.shiftKey === parts.includes('shift')
  })
  const key = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { if (picking) setPicking(false); else closePanel(); return }
    if (event.isComposing || event.repeat || event.defaultPrevented || event.composedPath().some(node => node instanceof HTMLElement && (node.matches('input,textarea,select') || (!picking && node.matches('button')) || node.isContentEditable))) return
    if (matchesShortcut(event)) {
      event.preventDefault()
      if (picking || panel.hidden) openPanel()
    }
  }
  const submit = () => {
    if (!context || stale || !ready || !diagnostic.ready || !input.value.trim() || [...pending.values()].some(request => request.type === 'task.create')) return
    lastInstruction = input.value.trim()
    send({ type: 'task.create', requestId: crypto.randomUUID(), context: { ...context, instruction: lastInstruction, scope: scope.value } }, true)
    input.value = ''
  }
  dock.onclick = () => { if (panel.hidden) openPanel(); else closePanel() }
  get<HTMLElement>('.close').onclick = closePanel
  get<HTMLElement>('.pick').onclick = () => setPicking(!picking)
  progressHead.onclick = () => { progressOpen = !progressOpen; renderTask() }
  get<HTMLElement>('.submit').onclick = submit
  input.onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit() } }
  get<HTMLElement>('.cancel').onclick = () => { if (activeId) send({ type: 'task.cancel', requestId: crypto.randomUUID(), taskId: activeId }) }
  get<HTMLElement>('.undo').onclick = () => { if (activeId) send({ type: 'task.undo', requestId: crypto.randomUUID(), taskId: activeId }) }
  history.onchange = () => { activeId = history.value; renderTask() }
  input.oninput = updateSubmit
  const observer = new MutationObserver(() => {
    if (selected && context && (!selected.isConnected || (context.sourceId && selected.getAttribute('data-va-id') !== context.sourceId))) {
      stale = true; targetText.textContent = '选中元素的源码或 DOM 已更新，请重新选择。'; updateSubmit(); draw()
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
  const compileError = (payload: { err: { message: string } }) => { get<HTMLElement>('.build-error').textContent = `编译诊断：${String(payload.err?.message ?? '未知错误').slice(0, 4000)}` }
  const afterUpdate = () => { get<HTMLElement>('.build-error').textContent = ''; ackPage() }
  import.meta.hot?.on('vite:error', compileError)
  import.meta.hot?.on('vite:afterUpdate', afterUpdate)
  const stop = () => {
    try { sessionStorage.setItem(panelKey, panel.hidden ? 'closed' : 'open') } catch { /* Storage may be unavailable. */ }
    stopped = true; ready = false; clearTimeout(reconnect); socket?.close(); observer.disconnect(); cancelAnimationFrame(frame)
    document.removeEventListener('mousemove', move, true); document.removeEventListener('mouseout', leave, true); document.removeEventListener('click', click, true); document.removeEventListener('pointerdown', pointerDown, true); document.removeEventListener('keydown', key, true)
    window.removeEventListener('scroll', scheduleDraw, true); window.removeEventListener('resize', scheduleDraw); window.removeEventListener('pagehide', stop); onVersion = () => {}; host.remove()
    import.meta.hot?.off('vite:error', compileError); import.meta.hot?.off('vite:afterUpdate', afterUpdate)
  }
  window.addEventListener('pagehide', stop)
  if (import.meta.hot) import.meta.hot.dispose(stop)
  connect()
}
