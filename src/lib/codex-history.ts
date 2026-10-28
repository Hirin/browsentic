/** Local Codex text only. No tool outputs, credentials, paths, or executable content. */
export interface CodexThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}

export interface CodexHistory {
  threads?: CodexThreadSummary[];
  nextCursor?: string | null;
  thread?: CodexThreadSummary;
  messages?: { role: 'user' | 'assistant'; text: string }[];
}

export const validCodexThreadId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** Content scripts are not allowed to request local conversation history. */
export function historyUiSender(sender: { id?: string; url?: string }, extensionId: string, extensionRoot: string): boolean {
  return sender.id === extensionId && sender.url === `${extensionRoot}sidepanel.html`;
}
