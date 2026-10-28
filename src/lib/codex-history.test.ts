import { describe, expect, test } from 'vitest';
import { historyUiSender, validCodexThreadId } from './codex-history';

describe('local history boundary', () => {
  const root = 'chrome-extension://browsentic/';
  test('only the extension side panel can request transcripts', () => {
    expect(historyUiSender({ id: 'browsentic', url: `${root}sidepanel.html` }, 'browsentic', root)).toBe(true);
    for (const url of ['https://evil.example/', `${root}sidepanel.html.evil`, `${root}sidepanel.html?forward=https://evil.example`, `${root}content.js`]) {
      expect(historyUiSender({ id: 'browsentic', url }, 'browsentic', root)).toBe(false);
    }
    expect(historyUiSender({ id: 'other', url: `${root}sidepanel.html` }, 'browsentic', root)).toBe(false);
    expect(historyUiSender({}, 'browsentic', root)).toBe(false);
  });
  test('thread identifiers cannot carry paths, flags, or shell expressions', () => {
    expect(validCodexThreadId('01a18055-91a3-7810-8bd7-3a837d9b3f6c')).toBe(true);
    for (const id of ['../../auth.json', '--help', '$(touch /tmp/injected)', 'abc\nturn/start', null, {}, '']) expect(validCodexThreadId(id)).toBe(false);
  });
});
