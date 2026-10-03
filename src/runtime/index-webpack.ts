import { initializeRuntime } from './entry'
import { createHot } from './hot-webpack'

initializeRuntime(createHot(import.meta.webpackHot))
if (import.meta.webpackHot) import.meta.webpackHot.accept()
export { mountDomino, reportVersion } from './entry'
