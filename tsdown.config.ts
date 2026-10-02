import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', vite: 'src/vite/index.ts', core: 'src/core/index.ts', transform: 'src/transform/index.ts', codex: 'src/agents/codex.ts', claude: 'src/agents/claude.ts' },
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: true,
    exports: false,
  },
  {
    entry: { runtime: 'src/runtime/index.ts' },
    platform: 'browser',
    dts: false,
    outExtensions: () => ({ js: '.mjs' }),
    sourcemap: true,
    clean: true,
    exports: false,
  },
])
