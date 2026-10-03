import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { test, expect, beforeAll, afterAll } from 'vitest'

import { createAgent } from '../src/agents'
import { ClaudeAdapter } from '../src/agents/claude'
import type { AgentInput } from '../src/core/types'

// Exercise the real SDK's stdio/control transport with a deterministic CLI.
// The fixture contains no model calls or real credentials.
// The adapter lets host env override settings.json routing, so scrub auth vars
// from the developer's shell for deterministic assertions.
const SCRUB = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']
const saved = Object.fromEntries(
  SCRUB.filter((key) => process.env[key]).map((key) => [key, process.env[key]]),
)
beforeAll(() => {
  for (const key of SCRUB) delete process.env[key]
})
afterAll(() => Object.assign(process.env, saved))

async function fixture(mode = 'normal') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-claude-sdk-')))
  const workspace = join(root, 'copy')
  await mkdir(join(workspace, 'src'), { recursive: true })
  await writeFile(join(workspace, 'src/App.tsx'), '<button>before</button>')
  await writeFile(
    join(root, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'fixture-token',
        ANTHROPIC_MODEL: 'fixture-default',
        DANGEROUS_SETTING: 'never-copy',
      },
      hooks: { SessionStart: [{ command: 'never-run' }] },
    }),
  )
  const executable = join(root, 'fake-claude')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
const trace = frame => fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(frame)+'\\n');
trace({args,pid:process.pid,routingCopied:process.env.ANTHROPIC_AUTH_TOKEN==='fixture-token',dangerousCopied:!!process.env.DANGEROUS_SETTING});
if (args.includes('--version')) { console.log(mode==='old'?'2.1.286 (Claude Code)':'2.1.287 (Claude Code)'); process.exit(0); }
if (args[0]==='auth') { console.log(JSON.stringify({loggedIn:mode!=='no-auth'})); process.exit(0); }
const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
let callbackId;
const result = (subtype, extra={}) => send({type:'result',subtype,is_error:false,result:'Button updated.',errors:[],...extra});
const rl = readline.createInterface({input:process.stdin});
rl.on('line', line => {
 const frame = JSON.parse(line); trace({frame});
 if (frame.type==='control_request' && frame.request.subtype==='initialize') {
  callbackId = frame.request.hooks.PreToolUse[0].hookCallbackIds[0];
  send({type:'control_response',response:{subtype:'success',request_id:frame.request_id,response:{commands:[],agents:[],models:[],account:{},hooks_applied:mode!=='no-hook'}}});
 }
 if (frame.type==='user') {
  send({type:'system',subtype:'init',tools:mode==='extra-tool'?['Read','Bash']:['Read','Glob','Grep','Edit','Write'],mcp_servers:[],plugins:[]});
  if (mode==='extra-tool') return;
  if (mode==='api-error') { result('success',{is_error:true,result:'API unavailable'}); return; }
  if (mode==='max-turns') { result('error_max_turns',{errors:['Turn limit reached']}); return; }
  if (mode==='incomplete') { process.exit(0); return; }
  send({type:'assistant',message:{content:[{type:'text',text:'Inspecting the selected source.'},{type:'tool_use',name:'Edit',id:'edit-1',input:{}}]}});
  if (mode==='wait') return;
  send({type:'control_request',request_id:'hook-1',request:{subtype:'hook_callback',callback_id:callbackId,tool_use_id:'edit-1',input:{hook_event_name:'PreToolUse',tool_name:'Edit',tool_input:{file_path:mode==='outside'?'/etc/hosts':'src/App.tsx',old_string:'before',new_string:'after'},session_id:'test',transcript_path:'',cwd:process.cwd(),tool_use_id:'edit-1'}}});
 }
 if (frame.type==='control_response' && frame.response.request_id==='hook-1') {
  const output=frame.response.response.hookSpecificOutput;
  if (output.permissionDecision==='deny') { result('error_during_execution',{errors:['File tool denied']}); return; }
  fs.writeFileSync(output.updatedInput.file_path, '<button>after</button>');
  send({type:'user',message:{content:[{type:'tool_result',tool_use_id:'edit-1',content:'Source changed.'}]}});
  send({type:'assistant',message:{content:[{type:'text',text:'Button updated.'}]}});
  result('success');
 }
});
rl.on('close',()=>process.exit(0));
`,
    { mode: 0o700 },
  )
  const adapter = new ClaudeAdapter({
    executable,
    configDir: root,
    model: 'fixture-model',
    effort: 'medium',
    maxTurns: 5,
  })
  const events: string[] = []
  const input: AgentInput = {
    workspaceRoot: workspace,
    writableDirectories: ['src'],
    signal: new AbortController().signal,
    prompt: 'Update the button',
    emit: (event) => events.push(event.text),
  }
  const calls = async () =>
    (await readFile(join(root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  return { root, workspace, adapter, input, events, calls }
}

test('streams through the actual Claude SDK with a file-only permission hook', async () => {
  const { root, workspace, adapter, input, events, calls } = await fixture()
  try {
    expect((await adapter.check()).ready).toBe(true)
    await adapter.run(input)
    expect(await readFile(join(workspace, 'src/App.tsx'), 'utf8')).toBe('<button>after</button>')
    expect(events).toEqual([
      'Inspecting the selected source.',
      'Claude 正在使用 Edit',
      'Claude 工具完成：Source changed.',
      'Button updated.',
    ])
    const invocations = await calls()
    const run = invocations.find((call) => call.args?.includes('--input-format'))!
    expect(run.args).toEqual(
      expect.arrayContaining([
        '--tools',
        'Read,Glob,Grep,Edit,Write',
        '--permission-mode',
        'dontAsk',
        '--strict-mcp-config',
        '--safe-mode',
        '--restricted',
        '--no-session-persistence',
        '--model',
        'fixture-model',
      ]),
    )
    expect(run.args).toContain('--setting-sources=')
    expect(run.routingCopied).toBe(true)
    expect(run.dangerousCopied).toBe(false)
    const hook = invocations.find(
      (call) =>
        call.frame?.type === 'control_response' && call.frame.response.request_id === 'hook-1',
    )!.frame.response.response.hookSpecificOutput
    expect(hook.permissionDecision).toBe('allow')
    expect(hook.updatedInput.file_path).toBe(join(workspace, 'src/App.tsx'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a CLI without hook registration before sending the user prompt', async () => {
  const { root, adapter, input, calls } = await fixture('no-hook')
  try {
    await expect(adapter.run(input)).rejects.toMatchObject({ code: 'CLAUDE_POLICY_UNAVAILABLE' })
    expect((await calls()).some((call) => call.frame?.type === 'user')).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('denies an outside file call through the SDK hook transport', async () => {
  const { root, workspace, adapter, input, events, calls } = await fixture('outside')
  try {
    await expect(adapter.run(input)).rejects.toMatchObject({ code: 'CLAUDE_TURN_FAILED' })
    expect(events.some((text) => text.includes('工具已拒绝'))).toBe(true)
    expect(
      (await calls()).find((call) => call.frame?.response?.request_id === 'hook-1')?.frame.response
        .response.hookSpecificOutput.permissionDecision,
    ).toBe('deny')
    expect(await readFile(join(workspace, 'src/App.tsx'), 'utf8')).toBe('<button>before</button>')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each([
  ['api-error', 'CLAUDE_TURN_FAILED'],
  ['max-turns', 'CLAUDE_TURN_FAILED'],
  ['incomplete', 'CLAUDE_INCOMPLETE'],
  ['extra-tool', 'CLAUDE_POLICY_UNAVAILABLE'],
])('reports %s as a failure', async (mode, code) => {
  const { root, adapter, input } = await fixture(mode)
  try {
    await expect(adapter.run(input)).rejects.toMatchObject({ code })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cancellation exits the Claude CLI before the copy can be cleaned up', async () => {
  const { root, adapter, input, calls } = await fixture('wait')
  try {
    const controller = new AbortController()
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const result = adapter.run({ ...input, signal: controller.signal, emit: started })
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    await running
    const invocation = (await calls()).find((call) => call.args?.includes('--input-format'))!
    controller.abort()
    await rejected
    expect(() => process.kill(invocation.pid, 0)).toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['old', 'no-auth'])('diagnoses %s before accepting a task', async (mode) => {
  const { root, adapter } = await fixture(mode)
  try {
    expect((await adapter.check()).ready).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('selects Codex, Claude and custom adapters and rejects invalid configuration', async () => {
  expect((await createAgent()).id).toBe('codex')
  expect((await createAgent({ provider: 'claude' })).id).toBe('claude')
  const custom = {
    id: 'custom',
    check: async () => ({ ready: true, message: 'ready' }),
    run: async () => {},
  }
  expect(await createAgent(custom)).toBe(custom)
  await expect(createAgent({ provider: 'unsupported' } as never)).rejects.toMatchObject({
    code: 'INVALID_CONFIG',
  })
  expect(() => new ClaudeAdapter({ maxTurns: 0 })).toThrow()
})
