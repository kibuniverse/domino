import { createHash } from 'node:crypto'

import { parse } from '@babel/parser'
import MagicString from 'magic-string'

import type { SourceRecord } from '../core/types'

export function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

type Node = {
  type: string
  start?: number
  end?: number
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } }
  [key: string]: unknown
}

export function instrument(code: string, file: string, footer = '') {
  const ast = parse(code, {
    sourceType: 'unambiguous',
    plugins: ['jsx', ...(/\.[cm]?tsx?$/.test(file) ? ['typescript' as const] : [])],
  })
  const output = new MagicString(code)
  const fileHash = hash(code)
  const records: SourceRecord[] = []
  const visit = (node: Node) => {
    if (node.type === 'JSXOpeningElement') {
      const name = node.name as Node
      const tagName = name.type === 'JSXIdentifier' ? String(name.name) : ''
      const attrs = node.attributes as Node[]
      if (
        /^[a-z]/.test(tagName) &&
        !tagName.includes('-') &&
        node.loc &&
        node.end != null &&
        !attrs.some((attr) => (attr.name as Node | undefined)?.name === 'data-va-id')
      ) {
        const sourceId = `s_${hash(`${file}\0${fileHash}\0${node.start}\0${tagName}`).slice(0, 24)}`
        records.push({
          sourceId,
          file,
          fileHash,
          tagName,
          start: { line: node.loc.start.line, column: node.loc.start.column + 1 },
          end: { line: node.loc.end.line, column: node.loc.end.column + 1 },
        })
        output.appendLeft(node.end - (node.selfClosing ? 2 : 1), ` data-va-id="${sourceId}"`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'loc' || key === 'tokens' || key === 'comments') continue
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === 'object' && typeof child.type === 'string')
            visit(child as Node)
      } else if (
        value &&
        typeof value === 'object' &&
        'type' in value &&
        typeof value.type === 'string'
      )
        visit(value as Node)
    }
  }
  visit(ast as unknown as Node)
  if (footer) output.append(footer)
  return {
    code: output.toString(),
    map: output.generateMap({ source: file, includeContent: true, hires: true }),
    records,
  }
}

export function validateSyntax(content: string, file: string): void {
  if (/\.[cm]?[jt]sx?$/.test(file))
    parse(content, {
      sourceType: 'unambiguous',
      plugins: ['jsx', ...(/\.[cm]?tsx?$/.test(file) ? ['typescript' as const] : [])],
    })
  else if (file.endsWith('.json')) JSON.parse(content)
}
