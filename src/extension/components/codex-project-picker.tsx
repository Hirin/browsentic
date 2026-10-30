import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { BRIDGE_CHANNEL, type ActionResult } from '@/lib/actions/protocol';
import type { CodexHistory, CodexProject } from '@/lib/codex-history';
import type { CodexAccess } from '@/lib/codex-access';

export function CodexProjectPicker({ connected, busy, value, onSelect, onSync, access, onAccess }: {
  connected: boolean;
  busy: boolean;
  value: string | null;
  onSelect: (id: string | null) => void;
  onSync?: () => void;
  access: CodexAccess;
  onAccess: (access: CodexAccess) => void;
}) {
  const [projects, setProjects] = useState<CodexProject[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!connected) return;
    let live = true;
    void (async () => {
      try {
        const all: CodexProject[] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 10; page++) {
          const result = await browser.runtime.sendMessage({ channel: BRIDGE_CHANNEL, op: 'codexHistory', operation: 'projects', cursor }) as ActionResult<CodexHistory>;
          if (!result?.ok) throw new Error(result?.error?.message ?? 'Could not load projects.');
          all.push(...result.data.projects ?? []);
          cursor = result.data.nextCursor ?? undefined;
          if (!cursor) break;
        }
        if (live) { setProjects(all); setError(''); }
      } catch (err) { if (live) setError(err instanceof Error ? err.message : 'Could not load projects.'); }
    })();
    return () => { live = false; };
  }, [connected]);
  const chosen = projects.find((project) => project.id === value);
  return <div className="border-b border-line px-3 pb-2 text-xs">
    <div className="mb-1 flex items-center justify-between gap-2">
      <label className="text-ink-faint" htmlFor="codex-project">Codex project</label>
      {onSync && <button type="button" className="text-brand disabled:opacity-50" disabled={busy || !connected} onClick={onSync}>Sync chat</button>}
    </div>
    <select id="codex-project" className="w-full rounded-lg border border-line bg-ground px-2 py-1.5 text-ink"
      value={value ?? ''} disabled={!connected || busy} onChange={(event) => {
        const id = event.target.value || null;
        void browser.runtime.sendMessage({ channel: BRIDGE_CHANNEL, op: 'setAgent', agent: 'codex' }).then((result: ActionResult) => {
          if (result?.ok) onSelect(id);
          else setError('Could not select Codex.');
        });
      }}>
      <option value="">No project · browser only</option>
      {value && !chosen && <option value={value}>Saved project</option>}
      {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
    {chosen && <p className="mt-1 truncate text-[10px] text-ink-faint" title={chosen.roots.join('\n')}>{chosen.roots[0]}</p>}
    <label htmlFor="codex-access" className="mt-2 block text-ink-faint">Permissions</label>
    <select id="codex-access" className="mt-1 w-full rounded-lg border border-line bg-ground px-2 py-1.5 text-ink"
      value={access} disabled={!connected || busy || !value} onChange={(event) => onAccess(event.target.value === 'full' ? 'full' : 'review')}>
      <option value="review">Review edits</option>
      <option value="full">Full access</option>
    </select>
    <p className={`mt-1 text-[10px] ${access === 'full' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-faint'}`}>
      {access === 'full' ? 'Can edit files outside this project, run commands and use the network without approval. Browser actions also skip confirmation; blocked actions stay blocked.' : 'Project edits need approval. Shell access is disabled.'}
    </p>
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
  </div>;
}
