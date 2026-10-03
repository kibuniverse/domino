// Adapted from React Bits AnimatedList. See SOURCE.md and LICENSE.md.
import { useRef } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'

interface Item { id: string; content: ReactNode; label: string }
interface Props { items: Item[]; selectedId?: string; onSelect: (id: string) => void; animate: boolean }

export default function AnimatedList({ items, selectedId, onSelect, animate }: Props) {
  const list = useRef<HTMLDivElement>(null)
  return <div ref={list} className="history-list" role="group" aria-label="历史任务" onKeyDown={event => {
    // Only handle arrows inside this list. Tab and Enter keep native button behavior.
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = [...list.current!.querySelectorAll<HTMLButtonElement>('button')]
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    buttons[Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
  }}>
    {items.map(item => <motion.div key={item.id} initial={animate ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }} transition={{ duration: animate ? 0.18 : 0 }}>
      <button className={`history-item${selectedId === item.id ? ' selected' : ''}`} aria-label={item.label}
        aria-pressed={selectedId === item.id} onClick={() => onSelect(item.id)}>{item.content}</button>
    </motion.div>)}
  </div>
}
