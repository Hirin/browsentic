import { expect, test } from 'vitest';
import { fullAccessAuthorized, validCodexAccess } from './codex-access';

test('full access needs an explicit trusted UI selection and a native project ID', () => {
  const id = '01a18055-91a3-7810-8bd7-3a837d9b3f6c';
  expect(fullAccessAuthorized('full', true, id)).toBe(true);
  for (const [access, ui, project] of [['full', false, id], ['review', true, id], [undefined, true, id], ['full', true, undefined], ['full', true, '../outside']]) {
    expect(fullAccessAuthorized(access, ui as boolean, project)).toBe(false);
  }
  for (const input of [true, null, {}, 'full-access', 'FULL']) expect(validCodexAccess(input)).toBe(false);
});
