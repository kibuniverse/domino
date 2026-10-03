import { getSession } from './bridge'

interface Context {
  _compiler: object
  cacheable(value: boolean): void
}
export default function bootstrapLoader(this: Context) {
  this.cacheable(false)
  const context = getSession(this._compiler)
  if (!context?.active) return ''
  const config = JSON.stringify(context.session.runtimeConfig()).replace(/</g, '\\u003c')
  return `import { mountDomino } from ${JSON.stringify(context.runtimeEntry)};\nconst mount = () => mountDomino(${config});\nif (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();\n`
}
