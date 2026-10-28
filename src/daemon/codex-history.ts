import { createInterface } from 'node:readline';
import { type ActionResult, failure, success } from '@/lib/actions/protocol';
import { type CodexHistory, type CodexThreadSummary, validCodexThreadId } from '@/lib/codex-history';
import { readAgentConfig } from './agent/config';
import { spawnCli, stopTree } from './agent/runners/command';
import { childEnv } from './agent/runners/drive';
import { stateDir } from './lockfile';

const MAX_BYTES = 32 * 1024 * 1024;

/** Deliberately not an agent tool or a /control operation. Only paired extension UI calls it. */
export async function codexHistory(request: { threadId?: unknown; cursor?: unknown }): Promise<ActionResult<CodexHistory>> {
  if (request.threadId !== undefined && !validCodexThreadId(request.threadId)) return failure('INVALID_INPUT', 'Invalid Codex thread ID.');
  if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 2048)) {
    return failure('INVALID_INPUT', 'Invalid history cursor.');
  }
  try {
    return success(await readHistory(request.threadId as string | undefined, request.cursor as string | undefined));
  } catch {
    // Codex errors can include transcript text or paths; never echo them into a page or a log.
    return failure('CODEX_HISTORY_FAILED', 'Could not read local Codex history. Check that Codex is installed and retry.');
  }
}

function readHistory(threadId?: string, cursor?: string): Promise<CodexHistory> {
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
          send({ id: 2, method: threadId ? 'thread/read' : 'thread/list', params: threadId
            ? { threadId, includeTurns: true }
            : { limit: 50, sortKey: 'updated_at', useStateDbOnly: true, cursor: cursor ?? null, sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'] } });
        } else if (message.id === 2) finish(projectHistory(message.result, threadId));
      } catch { finish(); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'browsentic_history', version: '0.9.0' } } });
  });
}

function summary(thread: Record<string, unknown>): CodexThreadSummary | null {
  if (!validCodexThreadId(thread.id)) return null;
  const title = typeof thread.name === 'string' ? thread.name : typeof thread.preview === 'string' ? thread.preview : 'Codex conversation';
  return { id: thread.id, title: title.slice(0, 160), updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : 0 };
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
