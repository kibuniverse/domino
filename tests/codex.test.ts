import { test, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexAdapter } from '../src/agents/codex'
import type { AgentInput } from '../src/core/types'

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'domino-sdk-test-')))
  await mkdir(join(root, 'src'))
  const executable = join(root, 'fake-codex')
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({args, home: process.env.CODEX_HOME, pid: process.pid})+'\\n');
if (args.includes('--version')) { console.log('codex-cli 0.160.0'); process.exit(0); }
if (args.includes('login')) { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'sandbox') {
 const unsafe = fs.existsSync(path.join(__dirname, 'unsafe'));
 process.exit(unsafe || args.at(-1).includes('.domino-probe-') ? 0 : 1);
}
if (args[0] !== 'exec' || !args.includes('--experimental-json')) { process.exit(2); }
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
 const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
 send({type:'thread.started',thread_id:'thread-1'});
 if (prompt === 'fail') { send({type:'turn.failed',error:{message:'Model unavailable'}}); return; }
 if (prompt === 'incomplete') { send({type:'error',message:'Disconnected'}); return; }
 send({type:'item.started',item:{id:'c',type:'command_execution',command:'inspect',status:'in_progress',aggregated_output:''}});
 if (prompt === 'wait') { setInterval(() => {}, 1000); return; }
 const cwd = args[args.indexOf('--cd')+1];
 fs.writeFileSync(path.join(cwd,'src/result.tsx'), '<button>changed</button>');
 send({type:'item.completed',item:{id:'c',type:'command_execution',command:'inspect',status:'completed',exit_code:0,aggregated_output:'source checked'}});
 send({type:'item.completed',item:{id:'f',type:'file_change',changes:[{path:'src/result.tsx',kind:'add'}],status:'completed'}});
 send({type:'item.completed',item:{id:'m',type:'agent_message',text:'Modified the button.'}});
 send({type:'turn.completed',usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0}});
});
`, { mode: 0o700 })
  const adapter = new CodexAdapter({ executable, authHome: root, model: 'test-model', effort: 'medium' })
  const events: string[] = []
  const input: AgentInput = { workspaceRoot: root, writableDirectories: ['src'], signal: new AbortController().signal, prompt: 'Change text', emit: event => events.push(event.text) }
  const calls = async () => (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as Array<{ args: string[]; home: string; pid: number }>
  return { root, adapter, input, events, calls }
}

test('uses the actual Codex SDK to stream CLI events with restricted configuration', async () => {
  const { root, adapter, input, events, calls } = await fixture()
  try {
    expect((await adapter.check()).message).toContain('Codex SDK')
    await adapter.run(input)
    expect(events).toEqual(['Codex 正在检查源码', 'Codex 检查结束：completed (exit 0)\nsource checked', 'Codex 编辑结束：completed', 'Modified the button.'])
    expect(await readFile(join(root, 'src/result.tsx'), 'utf8')).toContain('changed')
    const invocations = await calls()
    expect(invocations.filter(call => call.args[0] === 'sandbox')).toHaveLength(3)
    const exec = invocations.find(call => call.args[0] === 'exec')!
    expect(exec.args).toContain('--experimental-json')
    expect(exec.args).toContain('default_permissions="domino"')
    expect(exec.args).toContain('approval_policy="never"')
    expect(exec.args).toContain('model_reasoning_effort="medium"')
    expect(exec.args).toContain('test-model')
    expect(exec.args).not.toContain('--sandbox')
    expect(exec.args.some(arg => arg.startsWith('permissions.domino=') && arg.includes('"enabled"=false'))).toBe(true)
    expect(invocations.some(call => call.args.includes('app-server'))).toBe(false)
    await expect(readFile(join(exec.home, 'sandbox-sentinel'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('refuses to start an SDK turn when actual sandbox probes allow an outside read/write', async () => {
  const { root, adapter, input, calls } = await fixture()
  try {
    await writeFile(join(root, 'unsafe'), '')
    await expect(adapter.run(input)).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
    expect((await calls()).some(call => call.args[0] === 'exec')).toBe(false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('failed SDK turns are reported as failures', async () => {
  const { root, adapter, input } = await fixture()
  try { await expect(adapter.run({ ...input, prompt: 'fail' })).rejects.toMatchObject({ code: 'CODEX_TURN_FAILED', message: 'Model unavailable' }) }
  finally { await rm(root, { recursive: true, force: true }) }
})
test('an event stream without turn.completed never reports success', async () => {
  const { root, adapter, input } = await fixture()
  try { await expect(adapter.run({ ...input, prompt: 'incomplete' })).rejects.toMatchObject({ code: 'CODEX_INCOMPLETE', message: 'Disconnected' }) }
  finally { await rm(root, { recursive: true, force: true }) }
})
test('cancellation reaches the SDK AbortSignal and exits the CLI before cleanup', async () => {
  const { root, adapter, input, calls } = await fixture()
  try {
    const controller = new AbortController()
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const result = adapter.run({ ...input, prompt: 'wait', signal: controller.signal, emit: started })
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    await running
    const invocation = (await calls()).find(call => call.args[0] === 'exec')!
    controller.abort()
    await rejected
    expect(() => process.kill(invocation.pid, 0)).toThrow()
    await expect(readFile(join(invocation.home, 'sandbox-sentinel'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
