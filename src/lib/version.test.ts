import { describe, expect, test } from 'vitest';
import { isNewer } from './version';

describe('comparing versions', () => {
  const cases: [string, string, boolean][] = [
    ['0.7.0', '0.6.2', true],
    ['0.6.2', '0.6.2', false],
    ['0.6.10', '0.6.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.6.2', '0.7.0', false],
    ['0.7', '0.6.9', true],
    ['0.7.0', '0.7.0-rc.1', true],
    ['0.7.0-rc.1', '0.7.0', false],
    ['0.7.0-rc.2', '0.7.0-rc.1', true],
    ['0.7.0-rc.1', '0.6.2', true],
  ];
  for (const [candidate, current, newer] of cases) {
    test(`${candidate} is ${newer ? '' : 'not '}newer than ${current}`, () => {
      expect(isNewer(candidate, current)).toBe(newer);
    });
  }
});
