import { createInterface } from 'node:readline';
import { type ActionResult, failure, success } from '@/lib/actions/protocol';
import { type CodexHistory, type CodexHistoryQuery, type CodexProject, type CodexThreadSummary, validCodexThreadId } from '@/lib/codex-history';
import { readAgentConfig } from './agent/config';
import { spawnCli, stopTree } from './agent/runners/command';
import { childEnv } from './agent/runners/drive';
import { stateDir } from './lockfile';

const MAX_BYTES = 32 * 1024 * 1024;

/** Deliberately not an agent tool or a /control operation. Only paired extension UI calls it. */
export async function codexHistory(request: { threadId?: unknown; cursor?: unknown; operation?: unknown; projectId?: unknown }): Promise<ActionResult<CodexHistory>> {
  if (request.threadId !== undefined && !validCodexThreadId(request.threadId)) return failure('INVALID_INPUT', 'Invalid Codex thread ID.');
  if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 2048)) {
    return failure('INVALID_INPUT', 'Invalid history cursor.');
  }
  if (request.operation !== undefined && request.operation !== 'projects') return failure('INVALID_INPUT', 'Unknown history operation.');
  if (request.projectId !== undefined && request.projectId !== null && !validCodexThreadId(request.projectId)) return failure('INVALID_INPUT', 'Invalid project ID.');
  try {
    return success(await readHistory(request as CodexHistoryQuery));
  } catch {
    // Codex errors can include transcript text or paths; never echo them into a page or a log.
    return failure('CODEX_HISTORY_FAILED', 'Could not read local Codex history. Check that Codex is installed and retry.');
  }
}

function readHistory({ threadId, cursor, projectId, operation }: CodexHistoryQuery): Promise<CodexHistory> {
  return new Promise((resolve, reject) => {
    const child = spawnCli(readAgentConfig().agents.codex.bin, ['app-server', '--stdio', '-c', 'features.apps=false', '-c', 'features.plugins=false'], {
      cwd: stateDir, env: childEnv('codex'), stdin: 'pipe',
    });
    let bytes = 0;
    let settled = false;
    const lines = createInterface({ input: child.stdout });
    const finish = (result?: CodexHistory) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin?.end();
      stopTree(child, 'SIGTERM');
      const hardKill = setTimeout(() => stopTree(child, 'SIGKILL'), 1000);
      hardKill.unref();
      child.once('close', () => clearTimeout(hardKill));
      if (result) resolve(result);
      else reject(new Error('History unavailable'));
    };
    const timer = setTimeout(() => finish(), 20_000);
    const send = (message: unknown) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    child.stdin?.on('error', () => finish());
    child.on('error', () => finish());
    child.on('close', () => finish());
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) finish(); });
    lines.on('line', (line) => {
      if (settled) return;
      try {
        const message = JSON.parse(line);
        // No turn is started, no tool is executed, and no server request is approved.
        if (message.method) {
          if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Read-only history client' } });
          return;
        }
        if (message.error) return finish();
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: operation === 'projects' ? 'project/list' : threadId ? 'thread/read' : 'thread/list', params: operation === 'projects'
            ? { limit: 100, cursor: cursor ?? null }
            : threadId
            ? { threadId, includeTurns: true }
            : { limit: 50, sortKey: 'updated_at', useStateDbOnly: true, projectId, cursor: cursor ?? null, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] } });
        } else if (message.id === 2) finish(operation === 'projects' ? projectCatalog(message.result) : projectHistory(message.result, threadId));
      } catch { finish(); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'browsentic_history', version: '0.9.0' }, capabilities: { experimentalApi: true } } });
  });
}

function summary(thread: Record<string, unknown>): CodexThreadSummary | null {
  if (!validCodexThreadId(thread.id)) return null;
  const title = typeof thread.name === 'string' ? thread.name : typeof thread.preview === 'string' ? thread.preview : 'Codex conversation';
  return {
    id: thread.id, title: title.slice(0, 160), updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : 0,
    ...(validCodexThreadId(thread.projectId) ? { projectId: thread.projectId } : {}),
    ...(typeof thread.cwd === 'string' && thread.cwd.length <= 4096 ? { cwd: thread.cwd } : {}),
  };
}

export function projectCatalog(result: unknown): CodexHistory {
  const data = result as { data?: Record<string, unknown>[]; nextCursor?: string };
  const projects: CodexProject[] = [];
  for (const item of (data.data ?? []).slice(0, 100)) {
    if (!validCodexThreadId(item.id) || typeof item.name !== 'string' || !Array.isArray(item.roots)) continue;
    const roots = item.roots.flatMap((root) => typeof root?.path === 'string' && root.path.length <= 4096 && !root.path.includes('\0') ? [root.path] : []);
    if (roots.length) projects.push({ id: item.id, name: item.name.slice(0, 160), roots: roots.slice(0, 20) });
  }
  return { projects, nextCursor: data.nextCursor ?? null };
}

export async function savedCodexProjects(): Promise<CodexProject[]> {
  const projects: CodexProject[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const result = await codexHistory({ operation: 'projects', cursor });
    if (!result.ok) throw new Error(result.error.message);
    projects.push(...result.data.projects ?? []);
    cursor = result.data.nextCursor ?? undefined;
    if (!cursor) return projects;
  }
  throw new Error('Too many project pages.');
}

export function projectHistory(result: unknown, threadId?: string): CodexHistory {
  const data = result as { data?: Record<string, unknown>[]; nextCursor?: string; thread?: Record<string, unknown> & { turns?: { items?: Record<string, unknown>[] }[] } };
  if (!threadId) return { threads: (data.data ?? []).slice(0, 50).map(summary).filter((t): t is CodexThreadSummary => t !== null), nextCursor: data.nextCursor ?? null };
  const thread = data.thread && summary(data.thread);
  if (!thread || thread.id !== threadId) throw new Error('Mismatched thread');
  const messages: NonNullable<CodexHistory['messages']> = [];
  for (const turn of data.thread?.turns ?? []) {
    for (const item of turn.items ?? []) {
      if (item.type === 'agentMessage' && typeof item.text === 'string') messages.push({ role: 'assistant', text: item.text.slice(0, 50_000) });
      if (item.type === 'userMessage' && Array.isArray(item.content)) {
        const text = item.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
        if (text) messages.push({ role: 'user', text: text.slice(0, 50_000) });
      }
    }
  }
  return { thread, messages: messages.slice(-200) };
}
