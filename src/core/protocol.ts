import { DominoError } from './types'
import type { VisualContext } from './types'

export const STYLE_KEYS = [
  'display',
  'position',
  'color',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'borderRadius',
  'padding',
  'margin',
  'gap',
  'width',
  'height',
  'alignItems',
  'justifyContent',
] as const
const text = (value: unknown, max: number, label: string) => {
  if (typeof value !== 'string' || value.length > max)
    throw new DominoError('INVALID_REQUEST', `${label} 格式或长度无效。`)
  return value
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new DominoError('INVALID_REQUEST', '请求必须是对象。')
  return value as Record<string, unknown>
}
export function parseCreate(value: unknown): { requestId: string; context: VisualContext } {
  const request = object(value)
  const context = object(request.context)
  const element = object(context.element)
  const rect = object(element.rect)
  const styles = object(element.styles)
  const instruction = text(context.instruction, 4000, '修改要求').trim()
  if (!instruction) throw new DominoError('INVALID_REQUEST', '请输入修改要求。')
  const scope = context.scope
  if (scope !== 'auto' && scope !== 'usage' && scope !== 'component')
    throw new DominoError('INVALID_REQUEST', '作用范围无效。')
  if (context.locator !== 'exact' && context.locator !== 'ancestor')
    throw new DominoError('INVALID_REQUEST', '定位类型无效。')
  const cleanRect = {} as VisualContext['element']['rect']
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (typeof rect[key] !== 'number' || !Number.isFinite(rect[key]) || Math.abs(rect[key]) > 1e7)
      throw new DominoError('INVALID_REQUEST', '元素位置无效。')
    cleanRect[key] = rect[key]
  }
  const cleanStyles: Record<string, string> = {}
  for (const key of STYLE_KEYS)
    if (styles[key] != null) cleanStyles[key] = text(styles[key], 200, '样式')
  const requestId = text(request.requestId, 100, '请求 ID')
  if (!/^[\w-]{8,100}$/.test(requestId)) throw new DominoError('INVALID_REQUEST', '请求 ID 无效。')
  const sourceId = text(context.sourceId, 64, '源码 ID')
  if (!/^s_[a-f0-9]{24}$/.test(sourceId)) throw new DominoError('INVALID_REQUEST', '源码 ID 无效。')
  const route = text(context.route, 1000, '页面路径').split(/[?#]/)[0]
  return {
    requestId,
    context: {
      sourceId,
      instruction,
      scope,
      locator: context.locator,
      route,
      element: {
        tagName: text(element.tagName, 80, '标签'),
        text: text(element.text, 500, '元素文字'),
        rect: cleanRect,
        styles: cleanStyles,
      },
    },
  }
}
