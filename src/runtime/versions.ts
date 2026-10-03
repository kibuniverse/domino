// Module reports can arrive before the overlay mounts. Preserve the ledger across HMR.
const versions: Record<string, string> = import.meta.hot?.data.versions ?? Object.create(null)
const listeners = new Set<() => void>()
let frame = 0
export function reportVersion(file: string, version: string) {
  versions[file] = version
  if (!frame) frame = requestAnimationFrame(() => {
    frame = 0
    for (const listener of listeners) listener()
  })
}
export function subscribeVersions(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function reportedVersions(paths: string[]) {
  return Object.fromEntries(paths.filter(path => versions[path]).map(path => [path, versions[path]]))
}
if (import.meta.hot) import.meta.hot.dispose(data => {
  data.versions = versions
  cancelAnimationFrame(frame)
  listeners.clear()
})
