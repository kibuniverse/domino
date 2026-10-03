import { parse } from '@babel/parser'
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping'
import { describe, expect, test } from 'vitest'

import { instrument } from '../src/transform/index'

describe('JSX instrumentation', () => {
  test('marks DOM after spreads and leaves components, fragments and custom elements unchanged', () => {
    const code =
      'const App = () => <><Button/><button {...props}>保存</button><svg><path /></svg><x-widget /></>'
    const result = instrument(code, 'src/App.tsx')
    expect(result.records.map((record) => record.tagName)).toEqual(['button', 'svg', 'path'])
    expect(result.code).toMatch(/\.\.\.props}\s+data-va-id=/)
    expect(result.code).toContain('<Button/>')
    expect(result.code).toContain('<x-widget />')
    expect(() => parse(result.code, { plugins: ['jsx', 'typescript'] })).not.toThrow()
  })
  test('source positions refer to original code, IDs change with file versions', () => {
    const code = 'const A = () => <button>保存</button>'
    const result = instrument(code, 'src/A.tsx')
    const position = originalPositionFor(new TraceMap(result.map.toString()), {
      line: 1,
      column: result.code.indexOf('保存'),
    })
    expect(position.line).toBe(1)
    expect(position.column).toBe(code.indexOf('保存'))
    expect(result.records[0].start.column).toBe(code.indexOf('<button') + 1)
    expect(instrument(code, 'src/A.tsx').records[0].sourceId).toBe(result.records[0].sourceId)
    expect(instrument(code + '\n', 'src/A.tsx').records[0].sourceId).not.toBe(
      result.records[0].sourceId,
    )
  })
  test('preserves business attributes and rejects malformed JSX', () => {
    expect(instrument('<button data-va-id="business"/>', 'src/A.tsx').records).toHaveLength(0)
    expect(() => instrument('<button>', 'src/A.tsx')).toThrow()
  })
})
