import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = process.cwd()
const temporary = await mkdtemp(join(tmpdir(), 'domino-package-'))
const consumer = join(temporary, 'consumer')
const modules = join(consumer, 'node_modules')
async function link(name, installedName = name) {
  const target = join(modules, name)
  await mkdir(resolve(target, '..'), { recursive: true })
  await rm(target, { force: true, recursive: true })
  await symlink(resolve(root, 'node_modules', installedName), target, 'dir')
}
try {
  await mkdir(consumer, { recursive: true })
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}')
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(temporary, 'npm-cache') },
    }),
  )[0]
  const packageRoot = join(modules, '@kibuniverse/domino')
  await mkdir(packageRoot, { recursive: true })
  execFileSync('tar', [
    '-xzf',
    join(temporary, packed.filename),
    '-C',
    packageRoot,
    '--strip-components=1',
  ])
  for (const name of [
    'ws',
    'diff',
    'magic-string',
    '@babel/parser',
    '@types/node',
    'webpack',
    'webpack-dev-server',
  ])
    await link(name)
  const require = createRequire(join(consumer, 'package.json'))
  for (const name of ['webpack', 'rspack']) {
    assert.equal(typeof require(`@kibuniverse/domino/${name}`).domino, 'function')
    assert.equal(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { domino } from '@kibuniverse/domino/${name}'; console.log(typeof domino().apply)`,
        ],
        { cwd: consumer, encoding: 'utf8' },
      ).trim(),
      'function',
    )
  }
  // Verify both config formats against each engine's native types, with no unrelated peer.
  for (const engine of ['webpack', 'rspack1', 'rspack2']) {
    const rspack = engine !== 'webpack'
    if (rspack) {
      await rm(join(modules, 'webpack'), { force: true, recursive: true })
      await link('@rspack/core', engine === 'rspack1' ? 'rspack-v1' : '@rspack/core')
    }
    const entry = rspack ? 'rspack' : 'webpack'
    const source = `${rspack ? '' : "import type {} from 'webpack-dev-server'\n"}import type { Configuration } from '${rspack ? '@rspack/core' : 'webpack'}'\nimport { domino } from '@kibuniverse/domino/${entry}'\nconst plugin = domino({ base: '/preview/', shortcut: 'Space' })\nexport const config: Configuration = { mode: 'development', plugins: [plugin], devServer: { setupMiddlewares: plugin.setupMiddlewares } }\n`
    for (const extension of ['mts', 'cts']) {
      const file = join(consumer, `config.${extension}`)
      await writeFile(file, source)
      try {
        execFileSync(
          resolve(root, 'node_modules/.bin/tsc'),
          [
            '--noEmit',
            '--strict',
            '--module',
            'nodenext',
            '--target',
            'es2022',
            '--types',
            'node',
            file,
          ],
          { cwd: consumer, encoding: 'utf8', stdio: 'pipe' },
        )
      } catch (error) {
        throw new Error(
          `${engine} .${extension} typecheck failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`,
          { cause: error },
        )
      }
    }
  }
  console.log('Packed ESM/CommonJS imports and webpack/Rspack 1/2 config types passed.')
} finally {
  await rm(temporary, { force: true, recursive: true })
}
