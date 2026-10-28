import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { BRIDGE_CHANNEL, type ActionResult } from '@/lib/actions/protocol';
import { CODEX_PROJECT_KEY, type CodexHistory, type CodexHistoryQuery, type CodexThreadSummary } from '@/lib/codex-history';
import { putSession, updateSessionMeta } from '@/lib/bridge/session-store';
import { formatWhen } from '@/lib/format-when';

export function CodexHistoryPanel({ connected, busy, onOpen, projectId }: { connected: boolean; busy: boolean; onOpen: (id: string) => void; projectId?: string | null }) {
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  async function query(params: CodexHistoryQuery): Promise<CodexHistory> {
    const result = await browser.runtime.sendMessage({ channel: BRIDGE_CHANNEL, op: 'codexHistory', ...params }) as ActionResult<CodexHistory>;
    if (!result?.ok) throw new Error(result?.error?.message ?? 'Could not read local Codex history.');
    return result.data;
  }
  async function load(next?: string) {
    const generation = ++request.current;
    setLoading(true); setError('');
    try {
      const result = await query({ ...(next ? { cursor: next } : {}), ...(projectId ? { projectId } : {}) });
      if (generation !== request.current) return;
      setThreads((old) => next ? [...old, ...(result.threads ?? [])].filter((thread, index, all) => all.findIndex((t) => t.id === thread.id) === index) : result.threads ?? []);
      setCursor(result.nextCursor ?? null);
    } catch (err) { if (generation === request.current) setError(err instanceof Error ? err.message : 'Could not load history.'); }
    finally { if (generation === request.current) setLoading(false); }
  }
  useEffect(() => {
    setThreads([]); setCursor(null);
    if (connected) void load();
    else setLoading(false);
    return () => { request.current++; };
  }, [connected, projectId]);
  async function open(thread: CodexThreadSummary) {
    setLoading(true); setError('');
    try {
      const result = await query({ threadId: thread.id });
      const id = `codex:${thread.id}`;
      const messages = result.messages ?? [];
      await putSession({ id, agent: 'codex', agentSessionId: thread.id, ...(result.thread?.projectId ? { projectId: result.thread.projectId } : {}), turns: messages.filter((m) => m.role === 'user').length,
        createdAt: thread.updatedAt, updatedAt: thread.updatedAt }, [
        ...messages.map((m) => ({ kind: m.role, id: crypto.randomUUID(), text: m.text })),
        { kind: 'notice', id: crypto.randomUUID(), tone: 'info', text: result.thread?.projectId ? `Project conversation: ${result.thread.cwd ?? 'saved workspace'}. File reads are scoped to the project; edits need approval.` : 'Continuing this local Codex conversation with browser tools.' },
      ]);
      await updateSessionMeta(id, { title: thread.title });
      await browser.storage.local.set({ [CODEX_PROJECT_KEY]: result.thread?.projectId ?? null });
      const chosen = await browser.runtime.sendMessage({ channel: BRIDGE_CHANNEL, op: 'setAgent', agent: 'codex' }) as ActionResult;
      if (!chosen?.ok) throw new Error('Could not select Codex.');
      onOpen(id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not open conversation.'); }
    finally { setLoading(false); }
  }
  return <section className="border-b border-line p-3 text-xs">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-medium text-ink">Codex on this computer</h2>
      <button className="text-brand disabled:opacity-50" disabled={!connected || loading || busy} onClick={() => void load()}>Refresh</button>
    </div>
    <p className="mt-1 text-[11px] text-ink-faint">Open a saved Codex chat and continue it on this tab.</p>
    {!connected && <p className="mt-2 text-ink-faint">Connect Browsentic Bridge to load history.</p>}
    {error && <p role="alert" className="mt-2 text-red-500">{error}</p>}
    {threads.map((thread) => <button key={thread.id} type="button" disabled={busy || loading} onClick={() => void open(thread)}
      className="mt-2 block w-full rounded-xl border border-line p-2 text-left hover:border-line-strong disabled:opacity-50">
      <span className="block truncate text-ink">{thread.title}</span>
      {thread.cwd && <span className="block truncate text-[10px] text-ink-faint" title={thread.cwd}>{thread.cwd}</span>}
      <span className="text-[11px] text-ink-faint">{formatWhen(thread.updatedAt)}</span>
    </button>)}
    {loading && <p role="status" className="mt-2 text-ink-faint">Loading Codex history…</p>}
    {connected && !loading && !error && !threads.length && <p className="mt-2 text-ink-faint">No saved local Codex chats found.</p>}
    {cursor && <button className="mt-2 text-brand disabled:opacity-50" disabled={loading || busy} onClick={() => void load(cursor)}>Load more</button>}
  </section>;
}
