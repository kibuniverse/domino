import { useLayoutEffect, useRef } from 'react'

import type { Task } from '../../core/types'
import type { RuntimeController } from '../controller'
import { capabilities } from '../store'
import type { RuntimeState } from '../types'

export const labels: Record<Task['status'], string> = {
  queued: '排队中',
  running: 'Agent 执行中',
  cancelling: '正在停止',
  validating: '检查并应用',
  completed: '已完成',
  completed_with_issues: '完成但存在问题',
  failed: '失败',
  cancelled: '已取消',
}
export function taskLabel(task: Task) {
  return task.undone ? '已撤销' : labels[task.status]
}

function TaskLog({ logs, visible }: { logs: string[]; visible: boolean }) {
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  useLayoutEffect(() => {
    if (visible && follow.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [logs, visible])
  return (
    <div
      ref={log}
      className="log"
      onScroll={(event) => {
        const element = event.currentTarget
        follow.current = element.scrollHeight - element.clientHeight - element.scrollTop < 32
      }}
    >
      {logs.join('\n')}
    </div>
  )
}

export function TaskDetails({
  task,
  state,
  controller,
}: {
  task: Task
  state: RuntimeState
  controller: RuntimeController
}) {
  const actions = capabilities(state)
  return (
    <div className="task-details">
      <strong className="task-status">{taskLabel(task)}</strong>
      <div className="source muted">
        {task.source.file}:{task.source.start.line} · {task.applied ? '已应用' : '候选改动'}
      </div>
      <div className="page muted">
        {task.pageUpdate === 'received'
          ? '已收到浏览器模块更新确认，请核对当前页面。'
          : task.pageUpdate === 'pending'
            ? '页面更新待确认，请核对界面。'
            : ''}
      </div>
      <TaskLog logs={task.logs} visible={state.panelOpen && state.progressOpen} />
      <div className="task-error error" role="alert">
        {task.error ?? ''}
      </div>
      <div className="actions">
        <button className="ghost cancel" disabled={!actions.cancel} onClick={controller.cancel}>
          取消任务
        </button>
        <button className="ghost undo" disabled={!actions.undo} onClick={controller.undo}>
          撤销改动
        </button>
      </div>
      <div className="diffs">
        {task.changes.map((change) => (
          <details key={change.path}>
            <summary>{change.path}</summary>
            <pre className="diff">{change.patch}</pre>
          </details>
        ))}
      </div>
    </div>
  )
}
