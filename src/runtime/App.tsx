import { MotionConfig, motion, useReducedMotion } from 'motion/react'
import { useSyncExternalStore } from 'react'

import { InstructionForm } from './components/InstructionForm'
import { TargetSummary } from './components/TargetSummary'
import { TaskProgress } from './components/TaskProgress'
import type { RuntimeController } from './controller'

export function App({ controller }: { controller: RuntimeController }) {
  const state = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const reduced = useReducedMotion()
  const rect = state.highlight
  return (
    <MotionConfig reducedMotion="user">
      <div
        className="highlight"
        hidden={!rect}
        style={
          rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : undefined
        }
      />
      <button
        className={`dock${state.panelOpen ? ' active' : ''}`}
        aria-label="打开 domino"
        aria-expanded={state.panelOpen}
        onClick={controller.togglePanel}
      >
        <span className="gem" aria-hidden="true">
          ◆
        </span>
        <span>domino</span>
      </button>
      <div className="panel-position">
        <motion.section
          className="panel"
          role="dialog"
          aria-label="domino 前端修改"
          hidden={!state.panelOpen}
          initial={false}
          animate={{ opacity: state.panelOpen ? 1 : 0, y: state.panelOpen ? 0 : 10 }}
          transition={{ duration: reduced ? 0 : 0.2 }}
        >
          <div className="element-row">
            <TargetSummary context={state.context} stale={state.stale} />
            <button className="ghost pick" onClick={controller.togglePicking}>
              <span aria-hidden="true">◎</span>
              <span className="pick-label">{state.picking ? '退出选择' : '选择/切换元素'}</span>
            </button>
            <button className="close" aria-label="关闭面板" onClick={controller.closePanel}>
              ×
            </button>
          </div>
          <InstructionForm state={state} controller={controller} />
          <TaskProgress state={state} controller={controller} />
          <div className="notice" role="status">
            {state.notice}
          </div>
          <div className="build-error error" role="alert">
            {state.buildError}
          </div>
          <div className="foot">
            <small className="muted connection">{state.connectionMessage}</small>
            <small className="muted">源码上下文可能发送至模型服务</small>
          </div>
        </motion.section>
      </div>
    </MotionConfig>
  )
}
