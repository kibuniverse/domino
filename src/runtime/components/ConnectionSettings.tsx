import { useState } from 'react'

import type { RuntimeController } from '../controller'
import type { RuntimeState } from '../types'

export function ConnectionSettings({
  state,
  controller,
}: {
  state: RuntimeState
  controller: RuntimeController
}) {
  const [url, setUrl] = useState(state.serviceUrl)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  if (!state.settingsOpen) return null
  if (!state.deployed)
    return (
      <div className="connection-settings">
        <strong>项目开发服务</strong>
        <p className="muted">请确认开发服务器仍在运行。WebSocket 不可用时会自动改用 HTTP 连接。</p>
        <button className="ghost" onClick={controller.refreshPage}>
          刷新并重连
        </button>
      </div>
    )
  return (
    <div className="connection-settings">
      <strong>编辑服务</strong>
      <p className="muted">
        在项目源码所在的机器上启动 Domino Node 服务，然后填写服务地址和启动时显示的配对码。
      </p>
      <label>
        服务地址
        <input
          aria-label="服务地址"
          type="url"
          placeholder="https://editor.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label>
        配对码
        <input
          aria-label="配对码"
          type="password"
          autoComplete="off"
          value={code}
          onChange={(event) => setCode(event.target.value)}
        />
      </label>
      <div className="actions">
        <button
          className="ghost"
          disabled={busy || !url.trim()}
          onClick={() => {
            setBusy(true)
            void controller.testService(url).finally(() => setBusy(false))
          }}
        >
          测试连接
        </button>
        <button
          className="ghost"
          disabled={busy || !url.trim() || !code.trim()}
          onClick={() => {
            setBusy(true)
            void controller.configureService(url, code).finally(() => {
              setBusy(false)
              setCode('')
            })
          }}
        >
          {busy ? '连接中…' : '连接'}
        </button>
        <button
          className="ghost"
          disabled={busy || !state.ready}
          onClick={controller.disconnectService}
        >
          断开
        </button>
      </div>
      {state.projectName && <small className="muted">项目：{state.projectName}</small>}
    </div>
  )
}
