import { createHot } from './hot'
import { initializeRuntime } from './entry'

initializeRuntime(createHot(import.meta.hot))
// Vite detects this literal call when discovering the HMR boundary.
if (import.meta.hot) import.meta.hot.accept()
export { mountDomino, reportVersion } from './entry'
