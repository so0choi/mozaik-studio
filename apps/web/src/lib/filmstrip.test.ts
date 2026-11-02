import { describe, expect, it } from 'vitest';
import { regionsForThumb, sampleFrames, scaleRegions, tileCount } from './filmstrip';
import type { Region } from './types';

describe('tileCount', () => {
  it('is width/80 clamped to 8..40; unknown width gives the minimum', () => {
    expect(tileCount(0)).toBe(8);
    expect(tileCount(NaN)).toBe(8);
    expect(tileCount(400)).toBe(8);
    expect(tileCount(1600)).toBe(20);
    expect(tileCount(99999)).toBe(40);
  });
});

describe('sampleFrames', () => {
  it('picks evenly spaced midpoints inside the video', () => {
    expect(sampleFrames(100, 4)).toEqual([13, 38, 63, 88]);
  });
  it('clamps to the last frame and handles tiny videos', () => {
    expect(sampleFrames(3, 8).every((f) => f >= 0 && f <= 2)).toBe(true);
    expect(sampleFrames(0, 3)).toEqual([0, 0, 0]);
  });
  it('is non-decreasing', () => {
    const f = sampleFrames(250, 40);
    expect(f.length).toBe(40);
    for (let i = 1; i < f.length; i++) expect(f[i]).toBeGreaterThanOrEqual(f[i - 1]);
  });
});

const reg = (box: [number, number, number, number], block: number, over: Partial<Region> = {}): Region => ({
  id: 'r', shape: 'rect', box, points: null, effect: { type: 'mosaic', strength: 1, color: '#000000' }, block, ...over,
});

describe('scaleRegions', () => {
  it('scales position and size, and the block size (min 4px so a small face stays coarse)', () => {
    const out = scaleRegions([reg([320, 180, 64, 64], 16), reg([0, 0, 10, 10], 2)], 640, 360, 80, 45);
    expect(out[0].box).toEqual([40, 22, 8, 9]); // y 22.5..30.5 grows outward to 22..31
    expect(out[0].block).toBe(4);
    expect(scaleRegions([reg([0, 0, 640, 360], 128)], 640, 360, 80, 45)[0].block).toBe(16);
    expect(out[1].block).toBe(4);
  });
  it('never shrinks a box below the scaled area and keeps effect, shape and scaled points', () => {
    const eff = { type: 'blur' as const, strength: 3, color: '#112233' };
    const [o] = scaleRegions(
      [reg([101, 51, 3, 3], 8, { shape: 'polygon', effect: eff, points: [[101, 51], [104, 51], [102, 54]] })],
      640, 360, 80, 45,
    );
    expect(o.box[0]).toBeLessThanOrEqual(101 / 8);
    expect(o.box[0] + o.box[2]).toBeGreaterThanOrEqual(104 / 8);
    expect(o.box[2]).toBeGreaterThanOrEqual(1);
    expect(o.effect).toEqual(eff);
    expect(o.shape).toBe('polygon');
    expect(o.points).toEqual([[13, 6], [13, 6], [13, 7]]);
  });
  it('does not mutate its input', () => {
    const regions = [reg([10, 10, 10, 10], 4)];
    scaleRegions(regions, 100, 100, 50, 50);
    expect(regions[0].box).toEqual([10, 10, 10, 10]);
  });
});

describe('regionsForThumb', () => {
  it('includes neighbouring frames', () => {
    const a = reg([0, 0, 1, 1], 1);
    const b = reg([5, 5, 1, 1], 1);
    const c = reg([9, 9, 1, 1], 1);
    const m = new Map<number, Region[]>([[9, [a]], [10, [b]], [11, [c]], [20, [a]]]);
    expect(regionsForThumb(m, 10)).toEqual([a, b, c]);
    expect(regionsForThumb(m, 30)).toEqual([]);
  });
});
