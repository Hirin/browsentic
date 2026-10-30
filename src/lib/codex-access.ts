/** Per-turn permission selected in extension UI; never inferred from a saved chat or page. */
import { validCodexThreadId } from './codex-history';

export type CodexAccess = 'review' | 'full';

export const validCodexAccess = (value: unknown): value is CodexAccess => value === 'review' || value === 'full';

export function fullAccessAuthorized(access: unknown, trustedUi: boolean, projectId: unknown): boolean {
  return access === 'full' && trustedUi && validCodexThreadId(projectId);
}
