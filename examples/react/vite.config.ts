import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { domino } from '@kibuniverse/domino/vite'

const provider = process.env.DOMINO_AGENT ?? 'codex'
if (provider !== 'codex' && provider !== 'claude') throw new Error('DOMINO_AGENT must be codex or claude')

export default defineConfig({ plugins: [domino({ agent: { provider } }), react()] })
