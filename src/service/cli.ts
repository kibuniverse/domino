#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { errorMessage } from '../core/types'
import { startDominoService } from './index'

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.info('Usage: domino serve --config domino.server.json')
    return
  }
  if (args.length !== 3 || args[0] !== 'serve' || args[1] !== '--config') {
    console.error('Usage: domino serve --config domino.server.json')
    process.exitCode = 1
    return
  }
  const path = resolve(args[2])
  const config = JSON.parse(await readFile(path, 'utf8'))
  if (typeof config.root !== 'string') throw new Error('配置需要 root 源码目录。')
  config.root = resolve(dirname(path), config.root)
  const service = await startDominoService(config)
  const address = service.server.address()
  console.info(
    `domino: ${config.projectId} · ${typeof address === 'object' ? address?.port : address}`,
  )
  console.info(`domino: 配对码 ${service.pairingCode}（请仅交给项目编辑者）`)
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void service.close().catch((error) => {
      console.error(errorMessage(error))
      process.exitCode = 1
    })
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
void main().catch((error) => {
  console.error(errorMessage(error))
  process.exitCode = 1
})
