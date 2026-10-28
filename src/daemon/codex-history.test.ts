import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { configPath } from './agent/config';
import { stubCli } from './agent/runners/fixtures/support';
import { stateDir } from './lockfile';
import { codexHistory, projectCatalog, projectHistory } from './codex-history';

const id = '01a18055-91a3-7810-8bd7-3a837d9b3f6c';
const capture = join(stateDir, 'history-requests.jsonl');
function cli(reply: object, behavior = '') {
  const bin = stubCli(join(stateDir, 'history-codex'), `
    const fs = require('fs');
    require('readline').createInterface({ input: process.stdin }).on('line', line => {
      fs.appendFileSync(${JSON.stringify(capture)}, line + '\\n');
      const m = JSON.parse(line);
      ${behavior}
      if (m.id === 1) console.log(JSON.stringify({id: 1, result: {}}));
      if (m.id === 2) console.log(JSON.stringify({id: 2, result: ${JSON.stringify(reply)}}));
    });`);
  writeFileSync(configPath, JSON.stringify({ agents: { codex: { bin } } }));
}

beforeEach(() => { mkdirSync(stateDir, { recursive: true }); writeFileSync(capture, ''); });

describe('Codex history projection', () => {
  test('project choices expose only saved IDs, labels and bounded local roots', () => {
    expect(projectCatalog({ data: [
      { id, name: 'My project', roots: [{ path: '/projects/source' }, { path: '/bad\0root' }, {}], token: 'private-secret' },
      { id: '../forged', name: 'Forged', roots: [{ path: '/outside' }] },
      { id, name: 'No local root', roots: [] },
    ] })).toEqual({ projects: [{ id, name: 'My project', roots: ['/projects/source'] }], nextCursor: null });
  });
  test('returns authorized workspace metadata, excluding arbitrary fields', () => {
    expect(projectHistory({ data: [{ id, name: '<img src=x onerror=steal()>', updatedAt: 123, cwd: '/private/path', token: 'secret' }, { id: '../../auth.json' }], nextCursor: 'page2' }))
      .toEqual({ threads: [{ id, title: '<img src=x onerror=steal()>', updatedAt: 123000, cwd: '/private/path' }], nextCursor: 'page2' });
  });
  test('projects text messages only, never shell output, reasoning, attachments, or auth fields', () => {
    const result = projectHistory({ thread: { id, preview: 'test', turns: [{ items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'data:secret' }] },
      { type: 'commandExecution', aggregatedOutput: 'secret shell output' },
      { type: 'reasoning', text: 'secret reasoning' },
      { type: 'agentMessage', text: 'hi' },
    ] }] } }, id);
    expect(result.messages).toEqual([{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'hi' }]);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  test('does not accept a different thread than requested', () => {
    expect(() => projectHistory({ thread: { id: '00000000-0000-0000-0000-000000000000' } }, id)).toThrow('Mismatched thread');
  });
  test('bounds transcript retention and individual messages', () => {
    const result = projectHistory({ thread: { id, turns: [{ items: Array.from({ length: 220 }, () => ({ type: 'agentMessage', text: 'a'.repeat(60_000) })) }] } }, id);
    expect(result.messages).toHaveLength(200);
    expect(result.messages?.[0].text).toHaveLength(50_000);
  });
});

describe('read-only Codex process', () => {
  test('reads the native project catalog with experimental API support and no model turn', async () => {
    cli({ data: [{ id, name: 'Project', roots: [{ path: '/projects/source' }] }] });
    expect(await codexHistory({ operation: 'projects' })).toMatchObject({ ok: true, data: { projects: [{ id }] } });
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.map((m) => m.method)).toEqual(['initialize', 'initialized', 'project/list']);
    expect(requests[0].params.capabilities.experimentalApi).toBe(true);
  });
  test('filters history by the native project identity without scanning stale rollouts', async () => {
    cli({ data: [] });
    expect(await codexHistory({ projectId: id })).toMatchObject({ ok: true });
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests[2]).toMatchObject({ method: 'thread/list', params: { projectId: id, useStateDbOnly: true } });
  });
  test('lists desktop, CLI and app-server chats, without starting an agent turn', async () => {
    cli({ data: [{ id, preview: 'Local chat' }], nextCursor: 'next' });
    expect(await codexHistory({ cursor: 'opaque' })).toMatchObject({ ok: true, data: { threads: [{ id }], nextCursor: 'next' } });
    const requests = readFileSync(capture, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(requests.map((m) => m.method)).toEqual(['initialize', 'initialized', 'thread/list']);
    expect(requests[2].params).toMatchObject({ cursor: 'opaque', sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] });
  });
  test('reads an existing transcript without resuming it', async () => {
    cli({ thread: { id, turns: [] } });
    expect(await codexHistory({ threadId: id })).toMatchObject({ ok: true, data: { thread: { id }, messages: [] } });
    expect(readFileSync(capture, 'utf8')).toContain('thread/read');
    expect(readFileSync(capture, 'utf8')).not.toContain('thread/resume');
  });
  test('rejects invalid inputs before running the CLI', async () => {
    expect(await codexHistory({ threadId: '../../auth.json' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await codexHistory({ cursor: {} })).toMatchObject({ ok: false });
    expect(await codexHistory({ cursor: 'x'.repeat(2049) })).toMatchObject({ ok: false });
    expect(await codexHistory({ projectId: '../../outside' })).toMatchObject({ ok: false });
    expect(await codexHistory({ operation: 'turn/start' })).toMatchObject({ ok: false });
    expect(readFileSync(capture, 'utf8')).toBe('');
  });
  test('never returns arbitrary CLI errors or stderr containing secrets', async () => {
    cli({}, 'if(m.id === 2) { console.error("private-auth-secret"); console.log(JSON.stringify({id:2,error:{message:"private-auth-secret"}})); return; }');
    const result = await codexHistory({});
    expect(result).toMatchObject({ ok: false, error: { code: 'CODEX_HISTORY_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('private-auth-secret');
  });
  test('refuses malformed CLI output', async () => {
    cli({}, 'if(m.id === 2) { console.log("not JSON"); return; }');
    expect(await codexHistory({})).toMatchObject({ ok: false });
  });
});
