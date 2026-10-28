import { beforeEach, expect, test, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { WORKSPACE_PATCH } from '@/lib/workspace-tools';
import { runCommand } from './run-port';
import { ensureSessionForTab, patchSession } from './tab-sessions';
import * as socket from './socket';

beforeEach(() => { fakeBrowser.reset(); vi.restoreAllMocks(); });
let nextTab = 80000;

async function session(project: boolean, action: string) {
  const result = await ensureSessionForTab({ tabId: nextTab++, windowId: 1, url: 'https://example.test' });
  if (!result.ok) throw new Error(result.message);
  await patchSession(result.session.sessionId, { runId: 'active-run',
    ...(project ? { projectId: '01a18055-91a3-7810-8bd7-3a837d9b3f6c' } : {}),
    pendingApproval: { toolId: 'pending', action, input: {} },
  });
  return result.session.sessionId;
}

test('an in-page caller cannot approve a project patch, even when another approval is currently displayed', async () => {
  const send = vi.spyOn(socket, 'sendDecision').mockImplementation(() => {});
  const sessionId = await session(true, 'page.clickElement');
  runCommand({ op: 'decision', sessionId, toolId: 'earlier-project-patch', allow: true });
  // A decline is a queue barrier and remains available from any surface.
  runCommand({ op: 'decision', sessionId, toolId: 'pending', allow: false });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('active-run', 'pending', false, undefined));
  expect(send).toHaveBeenCalledTimes(1);
});

test('a pending file patch cannot be approved from an in-page caller even without restored project metadata', async () => {
  const send = vi.spyOn(socket, 'sendDecision').mockImplementation(() => {});
  const sessionId = await session(false, WORKSPACE_PATCH);
  runCommand({ op: 'decision', sessionId, toolId: 'pending', allow: true });
  runCommand({ op: 'decision', sessionId, toolId: 'pending', allow: false });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('active-run', 'pending', false, undefined));
  expect(send).toHaveBeenCalledTimes(1);
});

test('existing browser-only approvals still work from the in-page controls', async () => {
  const send = vi.spyOn(socket, 'sendDecision').mockImplementation(() => {});
  const sessionId = await session(false, 'page.clickElement');
  runCommand({ op: 'decision', sessionId, toolId: 'pending', allow: true });
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('active-run', 'pending', true, undefined));
});
