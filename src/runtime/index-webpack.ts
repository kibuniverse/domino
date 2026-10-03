import { createHot } from './hot-webpack'
import { initializeRuntime } from './entry'

initializeRuntime(createHot(import.meta.webpackHot))
if (import.meta.webpackHot) import.meta.webpackHot.accept()
export { mountDomino, reportVersion } from './entry'
