import type { Diagnostic, Task, VisualContext } from '../core/types'

export interface RuntimeConfig {
  token: string
  sessionId: string
  wsPath: string
  shortcuts: string[]
}
export interface RuntimeState {
  panelOpen: boolean
  progressOpen: boolean
  focusRequest: number
  draft: string
  scope: VisualContext['scope']
  context: VisualContext | null
  stale: boolean
  picking: boolean
  highlight: VisualContext['element']['rect'] | null
  ready: boolean
  pendingCreate: boolean
  diagnostic: Diagnostic
  connectionMessage: string
  tasks: Task[]
  activeId?: string
  notice: string
  buildError: string
}
