import { describe, expect, it } from 'vitest';
import { regionAt } from './hitTest';
import type { Region } from './types';

const fx = { type: 'mosaic' as const, strength: 3, color: '#000000' };
const mk = (id: string, shape: Region['shape'], box: Region['box'], points: Region['points'] = null): Region => ({
  id, shape, box, points, effect: fx, block: 8,
});

describe('regionAt', () => {
  it('hits a rect inside and misses outside', () => {
    const r = [mk('a', 'rect', [10, 10, 20, 20])];
    expect(regionAt(r, 15, 15)?.id).toBe('a');
    expect(regionAt(r, 31, 15)).toBeNull();
  });
  it('ellipse excludes the bounding-box corner', () => {
    const r = [mk('e', 'ellipse', [0, 0, 100, 100])];
    expect(regionAt(r, 50, 50)?.id).toBe('e');
    expect(regionAt(r, 2, 2)).toBeNull();
  });
  it('polygon uses its points', () => {
    const r = [mk('p', 'polygon', [0, 0, 100, 100], [[0, 0], [100, 0], [0, 100]])];
    expect(regionAt(r, 20, 20)?.id).toBe('p');
    expect(regionAt(r, 80, 80)).toBeNull();
  });
  it('returns the smallest region when several overlap', () => {
    const r = [mk('big', 'rect', [0, 0, 100, 100]), mk('small', 'rect', [10, 10, 20, 20])];
    expect(regionAt(r, 15, 15)?.id).toBe('small');
    expect(regionAt(r, 60, 60)?.id).toBe('big');
  });
  it('returns null for none or undefined', () => {
    expect(regionAt(undefined, 1, 1)).toBeNull();
    expect(regionAt([], 1, 1)).toBeNull();
  });
});
