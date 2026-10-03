import { useLayoutEffect, useRef } from 'react'

import type { RuntimeController } from '../controller'
import { capabilities } from '../store'
import type { RuntimeState } from '../types'
import GlideSelect from '../vendor/react-bits/GlideSelect'

const scopeOptions = [
  { value: 'auto', label: '由 Agent 判断' },
  { value: 'usage', label: '仅当前使用处（意图）' },
  { value: 'component', label: '修改共享组件' },
]

export function InstructionForm({
  state,
  controller,
}: {
  state: RuntimeState
  controller: RuntimeController
}) {
  const input = useRef<HTMLInputElement>(null)
  useLayoutEffect(() => {
    if (state.panelOpen && state.focusRequest) input.current?.focus()
  }, [state.focusRequest, state.panelOpen])
  return (
    <form
      className="input-row"
      onSubmit={(event) => {
        event.preventDefault()
        controller.submit()
      }}
    >
      <GlideSelect
        options={scopeOptions}
        value={state.scope}
        ariaLabel="作用范围"
        className="scope-select"
        disabled={!state.panelOpen}
        showTags={false}
        radius={14}
        menuWidth={224}
        accentColor="#c9b8ff"
        surfaceColor="#252631"
        highlightColor="#443762"
        textColor="#d6d9e2"
        onChange={(scope) => {
          if (scope === 'auto' || scope === 'usage' || scope === 'component')
            controller.store.update({ scope })
        }}
      />
      <input
        ref={input}
        id="domino-instruction"
        aria-label="修改要求"
        maxLength={4000}
        placeholder="描述修改要求，回车发送"
        autoComplete="off"
        value={state.draft}
        onChange={(event) => controller.store.update({ draft: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            if (!event.nativeEvent.isComposing) controller.submit()
          }
        }}
      />
      <button type="submit" className="submit" disabled={!capabilities(state).submit}>
        ↑ 发送
      </button>
    </form>
  )
}
