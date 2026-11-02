import { describe, expect, it } from 'vitest';
import { backgroundBlock, backgroundSigma, regionBlock, regionSigma } from './effectParams';
import { effectParamCases } from './fixtures';

const fns: Record<string, (...a: number[]) => number> = {
  region_block: regionBlock,
  region_sigma: regionSigma,
  background_block: backgroundBlock,
  background_sigma: backgroundSigma,
};

describe('effect params (shared fixture with worker effects)', () => {
  it('has cases', () => expect(effectParamCases.length).toBeGreaterThan(0));
  for (const c of effectParamCases) {
    it(`${c.fn}(${c.args.join(', ')}) = ${c.expected}`, () => {
      const fn = fns[c.fn];
      expect(fn, `unmapped fn ${c.fn}`).toBeDefined();
      expect(fn(...c.args)).toBeCloseTo(c.expected, 9);
    });
  }
});
