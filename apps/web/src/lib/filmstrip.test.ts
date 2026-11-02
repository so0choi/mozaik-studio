import { describe, expect, it } from 'vitest';
import { boxesForThumb, sampleFrames, scaleBoxes, tileCount } from './filmstrip';
import type { MaskBox } from './types';

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

describe('scaleBoxes', () => {
  it('scales position and size, and the block size (min 4px so a small face stays coarse)', () => {
    const boxes: MaskBox[] = [[320, 180, 64, 64, 16], [0, 0, 10, 10, 2]];
    const out = scaleBoxes(boxes, 640, 360, 80, 45);
    expect(out[0]).toEqual([40, 22.5, 8, 8, 4]);
    expect(scaleBoxes([[0, 0, 640, 360, 128]], 640, 360, 80, 45)[0][4]).toBe(16);
    expect(out[1][4]).toBe(4);
  });
  it('does not mutate its input', () => {
    const boxes: MaskBox[] = [[10, 10, 10, 10, 4]];
    scaleBoxes(boxes, 100, 100, 50, 50);
    expect(boxes[0]).toEqual([10, 10, 10, 10, 4]);
  });
});

describe('boxesForThumb', () => {
  it('includes neighbouring frames', () => {
    const a: MaskBox = [0, 0, 1, 1, 1];
    const b: MaskBox = [5, 5, 1, 1, 1];
    const c: MaskBox = [9, 9, 1, 1, 1];
    const m = new Map<number, MaskBox[]>([[9, [a]], [10, [b]], [11, [c]], [20, [a]]]);
    expect(boxesForThumb(m, 10)).toEqual([a, b, c]);
    expect(boxesForThumb(m, 30)).toEqual([]);
  });
});
