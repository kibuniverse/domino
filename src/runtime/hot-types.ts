/** The runtime only needs lifecycle memory and normalized build events. */
export interface HotBridge {
  data: Record<string, any>
  dispose(callback: (data: Record<string, any>) => void): void
  subscribe(error: (message: string) => void, updated: () => void): () => void
}
