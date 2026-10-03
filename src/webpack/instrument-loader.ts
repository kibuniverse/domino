import { getSession } from './bridge'

interface Context {
  _compiler: object
  _module?: { type?: string }
  resourcePath: string
  cacheable(value: boolean): void
  emitWarning(error: Error): void
  async(): (error: Error | null, code?: string, map?: any) => void
}
export default function instrumentLoader(this: Context, code: string, inputMap: unknown) {
  const context = getSession(this._compiler)
  if (!context?.active) return this.async()(null, code, inputMap)
  // A persistent compiler cache must not bypass the in-memory source registry.
  this.cacheable(false)
  const callback = this.async()
  const format = /\.[c][jt]s$/.test(this.resourcePath) || this._module?.type === 'javascript/dynamic' ? 'commonjs' : 'esm'
  context.session.transform(code, this.resourcePath, context.runtimeEntry, message => this.emitWarning(new Error(message)), format)
    .then(result => callback(null, result?.code ?? code, result ? JSON.parse(result.map.toString()) : inputMap), error => callback(error))
}
