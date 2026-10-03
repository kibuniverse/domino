import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect } from 'vitest'

import { ClaudeFilePolicy } from '../src/agents/claude-policy'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-claude-policy-')))
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src/App.tsx'), '<button>before</button>')
  await writeFile(join(root, 'package.json'), '{}')
  return { root, policy: new ClaudeFilePolicy(root, ['src']) }
}

test('canonicalizes source paths and allows metadata only for reading', async () => {
  const { root, policy } = await fixture()
  try {
    expect(await policy.authorize('Read', { file_path: 'src/App.tsx', limit: 20 })).toEqual({
      file_path: join(root, 'src/App.tsx'),
      limit: 20,
    })
    expect(await policy.authorize('Read', { file_path: 'package.json' })).toEqual({
      file_path: join(root, 'package.json'),
    })
    expect(
      await policy.authorize('Write', {
        file_path: 'src/components/New.tsx',
        content: '<button />',
      }),
    ).toMatchObject({ file_path: join(root, 'src/components/New.tsx') })
    await expect(policy.authorize('Edit', { file_path: 'package.json' })).rejects.toMatchObject({
      code: 'CLAUDE_TOOL_DENIED',
    })
    await expect(policy.authorize('Read', { file_path: 'src/missing.tsx' })).rejects.toMatchObject({
      code: 'CLAUDE_TOOL_DENIED',
    })
    await expect(policy.authorize('Read', { file_path: 'src' })).rejects.toMatchObject({
      code: 'CLAUDE_TOOL_DENIED',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('denies tools and file targets outside the supported copy scope', async () => {
  const { root, policy } = await fixture()
  try {
    for (const tool of ['Bash', 'Agent', 'WebFetch', 'NotebookEdit', 'mcp__external__read'])
      await expect(policy.authorize(tool, { file_path: 'src/App.tsx' })).rejects.toMatchObject({
        code: 'CLAUDE_TOOL_DENIED',
      })
    for (const file_path of [
      '../outside.tsx',
      '/etc/hosts',
      'src/.env',
      'src/secrets/key.ts',
      'src/key.pem',
      'vite.config.ts',
      'src/data.png',
    ])
      await expect(policy.authorize('Write', { file_path, content: '' })).rejects.toMatchObject({
        code: 'CLAUDE_TOOL_DENIED',
      })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prevents direct, parent and recursive search symlink escapes', async () => {
  const { root, policy } = await fixture()
  try {
    await symlink('/private/tmp', join(root, 'src/link'))
    for (const file_path of ['src/link', 'src/link/outside.tsx'])
      await expect(policy.authorize('Read', { file_path })).rejects.toMatchObject({
        code: 'CLAUDE_TOOL_DENIED',
      })
    await expect(
      policy.authorize('Write', { file_path: 'src/link/new.tsx', content: '' }),
    ).rejects.toMatchObject({ code: 'CLAUDE_TOOL_DENIED' })
    await expect(policy.authorize('Glob', { pattern: '**/*.tsx' })).rejects.toMatchObject({
      code: 'CLAUDE_TOOL_DENIED',
    })
    await expect(policy.authorize('Grep', { pattern: 'before' })).rejects.toMatchObject({
      code: 'CLAUDE_TOOL_DENIED',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('searches within the copy and rejects glob escape expressions', async () => {
  const { root, policy } = await fixture()
  try {
    expect(await policy.authorize('Glob', { pattern: '**/*.{ts,tsx}', path: 'src' })).toMatchObject(
      { path: join(root, 'src') },
    )
    expect(await policy.authorize('Grep', { pattern: 'before' })).toMatchObject({ path: root })
    for (const pattern of ['/etc/*', '../*', '{src/*,/etc/*}', '~/*', '!(src)/*', 'C:\\*'])
      await expect(policy.authorize('Glob', { pattern })).rejects.toMatchObject({
        code: 'CLAUDE_TOOL_DENIED',
      })
    await expect(
      policy.authorize('Grep', { pattern: 'before', glob: '../*' }),
    ).rejects.toMatchObject({ code: 'CLAUDE_TOOL_DENIED' })
    await expect(
      policy.authorize('Grep', { pattern: 'before', path: '/etc' }),
    ).rejects.toMatchObject({ code: 'CLAUDE_TOOL_DENIED' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
