import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { CODEX_PROJECT_KEY, validCodexThreadId } from '@/lib/codex-history';

export function useCodexProject(): [string | null, (id: string | null) => Promise<void>] {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void browser.storage.local.get(CODEX_PROJECT_KEY).then((values) => {
      if (live) setSelected(validCodexThreadId(values[CODEX_PROJECT_KEY]) ? values[CODEX_PROJECT_KEY] : null);
    });
    const changed = (values: Record<string, { newValue?: unknown }>) => {
      if (CODEX_PROJECT_KEY in values) {
        const value = values[CODEX_PROJECT_KEY].newValue;
        setSelected(validCodexThreadId(value) ? value : null);
      }
    };
    browser.storage.local.onChanged.addListener(changed);
    return () => { live = false; browser.storage.local.onChanged.removeListener(changed); };
  }, []);
  return [selected, async (id) => {
    if (id !== null && !validCodexThreadId(id)) throw new Error('Invalid project');
    await browser.storage.local.set({ [CODEX_PROJECT_KEY]: id });
    setSelected(id);
  }];
}
