export interface SourceRecord {
  sourceId: string
  file: string
  fileHash: string
  start: { line: number; column: number }
  end: { line: number; column: number }
  tagName: string
}

export interface VisualContext {
  sourceId: string
  instruction: string
  scope: 'auto' | 'usage' | 'component'
  element: {
    tagName: string
    text: string
    rect: { x: number; y: number; width: number; height: number }
    styles: Record<string, string>
  }
  route: string
  locator: 'exact' | 'ancestor'
}

export interface Diagnostic { ready: boolean; message: string }
export interface AgentEvent { type: 'message' | 'tool'; text: string }
export interface AgentInput {
  workspaceRoot: string
  writableDirectories: string[]
  prompt: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
}
export interface AgentAdapter {
  id: string
  check(): Promise<Diagnostic>
  run(input: AgentInput): Promise<void>
}

export type TaskStatus = 'queued' | 'running' | 'cancelling' | 'validating' | 'completed' | 'completed_with_issues' | 'failed' | 'cancelled'
export interface FileChange {
  path: string
  before: string | null
  after: string | null
  beforeHash: string | null
  afterHash: string | null
  patch: string
}
export interface Task {
  id: string
  requestId: string
  status: TaskStatus
  instruction: string
  source: SourceRecord
  createdAt: string
  seq: number
  logs: string[]
  changes: Array<Pick<FileChange, 'path' | 'patch'>>
  applied: boolean
  undone: boolean
  error?: string
  pageUpdate: 'pending' | 'received' | 'not_applicable'
}
export const TERMINAL = new Set<TaskStatus>(['completed', 'completed_with_issues', 'failed', 'cancelled'])

export class DominoError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DominoError' }
}
export function errorMessage(error: unknown): string {
  return error instanceof DominoError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error)
}
