import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const browserRuntime = (webpack = false): UserConfig => ({
  entry: { [webpack ? 'runtime-webpack' : 'runtime']: webpack ? 'src/runtime/index-webpack.ts' : 'src/runtime/index.ts' },
  platform: 'browser',
  dts: false,
  deps: {
    neverBundle: [/^react(?:-dom)?(?:\/|$)/],
    alwaysBundle: [/^(?:motion|framer-motion|motion-dom|motion-utils|@hugeicons\/react|@hugeicons\/core-free-icons)(?:\/|$)/],
    onlyBundle: ['motion', 'framer-motion', 'motion-dom', 'motion-utils', '@hugeicons/react', '@hugeicons/core-free-icons'],
    onlyImport: ['react', 'react-dom'],
  },
  minify: true,
  inputOptions: {
    onwarn(warning, defaultHandler) {
      // This entry is browser-only; React Server Component directives are irrelevant.
      if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return
      defaultHandler(warning)
    },
  },
  plugins: [{
    name: 'domino-shadow-css',
    resolveId(source, importer) {
      if (source.endsWith('.css?inline') && importer) return resolve(dirname(importer), source)
    },
    load(id) {
      if (id.endsWith('.css?inline')) {
        const path = id.slice(0, -7)
        this.addWatchFile(path)
        return `export default ${JSON.stringify(readFileSync(path, 'utf8'))}`
      }
    },
  }],
  copy: [{ from: ['src/runtime/vendor/react-bits/LICENSE.md', 'src/runtime/vendor/react-bits/SOURCE.md'], to: 'dist/third-party/react-bits' }],
  outExtensions: () => ({ js: '.mjs' }),
  sourcemap: true,
  clean: true,
  exports: false,
})

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
    entry: { webpack: 'src/webpack/index.ts', rspack: 'src/rspack/index.ts' },
    platform: 'node', format: ['esm', 'cjs'], dts: true,
    sourcemap: true, exports: false,
  },
  {
    entry: { 'domino-instrument': 'src/webpack/instrument-loader.ts', 'domino-bootstrap': 'src/webpack/bootstrap-loader.ts' },
    platform: 'node', format: 'cjs', cjsDefault: true,
    dts: false, sourcemap: true, exports: false,
  },
  browserRuntime(),
  browserRuntime(true),
])
