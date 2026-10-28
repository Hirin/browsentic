/** Local Codex display metadata. Tool outputs and credentials are never projected. */
export interface CodexProject {
  id: string;
  name: string;
  roots: string[];
}

export interface CodexThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
  projectId?: string;
  cwd?: string;
}

export interface CodexHistory {
  projects?: CodexProject[];
  threads?: CodexThreadSummary[];
  nextCursor?: string | null;
  thread?: CodexThreadSummary;
  messages?: { role: 'user' | 'assistant'; text: string }[];
}

export interface CodexHistoryQuery {
  operation?: 'projects';
  threadId?: string;
  cursor?: string;
  projectId?: string | null;
}

export const CODEX_PROJECT_KEY = 'browsentic/codexProject';

export const validCodexThreadId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Content scripts are not allowed to request local conversation history. */
export function historyUiSender(sender: { id?: string; url?: string }, extensionId: string, extensionRoot: string): boolean {
  return sender.id === extensionId && sender.url === `${extensionRoot}sidepanel.html`;
}
