import { useReducedMotion } from 'motion/react'
import { TERMINAL } from '../../core/types'
import type { RuntimeState } from '../types'
import type { RuntimeController } from '../controller'
import ShinyText from '../vendor/react-bits/ShinyText'
import AnimatedList from '../vendor/react-bits/AnimatedList'
import { TaskDetails, taskLabel } from './TaskDetails'

export function TaskProgress({ state, controller }: { state: RuntimeState; controller: RuntimeController }) {
  const reduced = useReducedMotion()
  const task = state.tasks.find(task => task.id === state.activeId)
  if (!task) return null
  const working = !task.undone && !TERMINAL.has(task.status)
  const label = working ? '正在处理中' : taskLabel(task)
  return <div className={`progress${working ? ' working' : ''}${state.progressOpen ? ' open' : ''}`}>
    <button className="progress-head" aria-expanded={state.progressOpen} aria-controls="domino-progress-body"
      onClick={() => controller.store.update({ progressOpen: !state.progressOpen })}>
      <span className="progress-dot" aria-hidden="true" />
      {working && state.panelOpen && !reduced ? <ShinyText text={label} className="progress-label" speed={1.6} color="#8f95a3" shineColor="#eef0f5" /> : <span className="progress-label">{label}</span>}
      <span className="progress-caret" aria-hidden="true">⌄</span>
    </button>
    <div className="progress-fold" id="domino-progress-body" inert={!state.progressOpen}><div className="progress-clip"><div className="progress-body">
      <AnimatedList selectedId={state.activeId} animate={state.panelOpen && state.progressOpen && !reduced}
        onSelect={activeId => controller.store.update({ activeId })}
        items={state.tasks.map(task => ({ id: task.id, label: `查看任务：${task.instruction}`, content: <>
          <span className="history-title">{task.instruction}</span>
          <span className="muted">{taskLabel(task)} · {new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </> }))} />
      <TaskDetails key={task.id} task={task} state={state} controller={controller} />
    </div></div></div>
  </div>
}
