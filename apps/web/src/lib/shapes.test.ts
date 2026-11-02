import { describe, expect, it } from 'vitest';
import { shapeMaskCases } from './fixtures';
import { shapeBitmap } from './shapes';

function rows(bm: Uint8Array, w: number, h: number): string[] {
  return Array.from({ length: h }, (_, j) => Array.from(bm.slice(j * w, (j + 1) * w)).join(''));
}

describe('shapeBitmap', () => {
  it('matches shared shape masks', () => {
    expect(shapeMaskCases.length).toBeGreaterThan(0);
    for (const c of shapeMaskCases) {
      expect(rows(shapeBitmap(c.shape, c.w, c.h, c.points), c.w, c.h), c.name).toEqual(c.rows);
    }
  });

  it('never leaves a tiny, degenerate or unknown shape unmasked', () => {
    expect(Array.from(shapeBitmap('ellipse', 3, 9, null)).every((v) => v === 1)).toBe(true);
    expect(Array.from(shapeBitmap('polygon', 8, 8, [[0, 0], [7, 7]])).every((v) => v === 1)).toBe(true);
    expect(Array.from(shapeBitmap('polygon', 8, 8, null)).every((v) => v === 1)).toBe(true);
    expect(Array.from(shapeBitmap('star' as never, 8, 8, null)).every((v) => v === 1)).toBe(true);
  });
});
