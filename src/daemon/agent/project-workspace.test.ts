import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunEvent } from '@/lib/actions/protocol';
import { success } from '@/lib/actions/protocol';
import { AGENT_KINDS } from '@/lib/agents/catalog';
import { WORKSPACE_ACTIONS, WORKSPACE_PATCH, WORKSPACE_READ } from '@/lib/workspace-tools';
import { configPath } from './config';
import { stateDir } from '../lockfile';
import { WorkspaceFiles } from '../workspace-files';
import { stubCli } from './runners/fixtures/support';
import { AgentSession } from './service';

const resolveWorkspace = vi.hoisted(() => vi.fn());
vi.mock('../workspace-files', async (original) => ({ ...await original<object>(), projectWorkspace: resolveWorkspace }));
const projectId = '01a18055-91a3-7810-8bd7-3a837d9b3f6c';
let agent: AgentSession;
let files: WorkspaceFiles;
let root: string;
let events: RunEvent[];

beforeEach(() => {
  root = join(stateDir, 'approved-project'); mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'code.txt'), 'before\n');
  const bin = stubCli(join(stateDir, 'workspace-codex'), "if(process.argv.includes('--version')){console.log('codex-cli 0.163.0');process.exit(0)}setTimeout(()=>{},30000)");
  writeFileSync(configPath, JSON.stringify({ agent: 'codex', agents: Object.fromEntries(AGENT_KINDS.map((kind) => [kind, { bin: kind === 'codex' ? bin : '/nonexistent/agent' }])) }));
  files = new WorkspaceFiles({ id: projectId, name: 'Approved project', roots: [root] });
  resolveWorkspace.mockReset().mockResolvedValue(files);
  events = [];
  agent = new AgentSession({ invoke: async () => success({}), emit: (_id, event) => events.push(event), draft: () => {}, actionNames: () => [] });
});
afterEach(() => agent.dispose());

async function start(project = true) {
  agent.handle({ t: 'instruct', id: 'run', text: 'Inspect the selected project.', context: { sessionId: 'browser-session', ...(project ? { projectId } : {}) } });
  if (project) await vi.waitFor(() => expect(agent.offerFor('run')?.reserved).toEqual(expect.arrayContaining(WORKSPACE_ACTIONS)));
}
function patch(text: string) { return { path: 'code.txt', sha256: files.read({ path: 'code.txt' }).sha256, startLine: 1, endLine: 1, text }; }
async function pending(count: number) {
  await vi.waitFor(() => expect(events.filter((event) => event.kind === 'approval')).toHaveLength(count));
  return events.filter((event): event is Extract<RunEvent, { kind: 'approval' }> => event.kind === 'approval').at(-1)!;
}

describe('project permissions on agent runs', () => {
  test('a run without a selected project is offered no file tools and cannot call one directly', async () => {
    await start(false);
    expect(agent.offerFor('run')?.reserved.some((action) => WORKSPACE_ACTIONS.includes(action))).toBe(false);
    expect(await agent.invokeForRun('run', WORKSPACE_READ, { path: 'code.txt' })).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BLOCKED' } });
    expect(resolveWorkspace).not.toHaveBeenCalled();
  });
  test('a selected project is resolved on the server and read results include a usable revision', async () => {
    await start();
    expect(resolveWorkspace).toHaveBeenCalledWith(projectId, null);
    const result = await agent.invokeForRun('run', WORKSPACE_READ, { path: 'code.txt' });
    expect(result).toMatchObject({ ok: true, data: { content: '1: before\n2: ', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  });
  test('every patch waits for its own approval, including after remember=true', async () => {
    await start();
    const first = agent.invokeForRun('run', WORKSPACE_PATCH, patch('first'));
    const asked = await pending(1);
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('before\n');
    expect(asked.input).toMatchObject({ workspace: root, path: 'code.txt', before: 'before', after: 'first' });
    agent.handle({ t: 'decision', id: 'run', toolId: asked.toolId, allow: true, remember: true });
    expect(await first).toMatchObject({ ok: true, data: { written: true } });
    const second = agent.invokeForRun('run', WORKSPACE_PATCH, patch('second'));
    const again = await pending(2);
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('first\n');
    agent.handle({ t: 'decision', id: 'run', toolId: again.toolId, allow: true });
    expect(await second).toMatchObject({ ok: true });
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('second\n');
  });
  test('denied and abandoned approvals never write', async () => {
    await start();
    const denied = agent.invokeForRun('run', WORKSPACE_PATCH, patch('denied'));
    const asked = await pending(1);
    agent.handle({ t: 'decision', id: 'run', toolId: asked.toolId, allow: false });
    expect(await denied).toMatchObject({ ok: false });
    const abort = new AbortController();
    const abandoned = agent.invokeForRun('run', WORKSPACE_PATCH, patch('abandoned'), abort.signal);
    await pending(2); abort.abort();
    expect(await abandoned).toMatchObject({ ok: false });
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('before\n');
  });
  test('a concurrent edit is preserved even after the pending proposal is allowed', async () => {
    await start();
    const result = agent.invokeForRun('run', WORKSPACE_PATCH, patch('agent change'));
    const asked = await pending(1);
    writeFileSync(join(root, 'code.txt'), 'user change');
    agent.handle({ t: 'decision', id: 'run', toolId: asked.toolId, allow: true });
    expect(await result).toMatchObject({ ok: false, error: { code: 'REVISION_MISMATCH' } });
    expect(readFileSync(join(root, 'code.txt'), 'utf8')).toBe('user change');
  });
  test('a forged path is refused before it can request approval', async () => {
    await start();
    expect(await agent.invokeForRun('run', WORKSPACE_PATCH, { ...patch('bad'), path: '../outside.txt' })).toMatchObject({ ok: false });
    expect(events.some((event) => event.kind === 'approval')).toBe(false);
  });
});
