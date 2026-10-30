import { describe, expect, it } from 'vitest';
import { frameAt, formatTime } from './frames';
import { containRect, toDisplay, fromDisplay } from './geometry';

describe('frameAt', () => {
  it('rounds mediaTime*fps', () => {
    expect(frameAt(1.5, 30)).toBe(45);
    expect(frameAt(1.49, 30)).toBe(45);
    expect(frameAt(0, 30)).toBe(0);
    expect(frameAt(1.0166, 30)).toBe(30);
  });
});

describe('formatTime', () => {
  it('formats mm:ss', () => {
    expect(formatTime(84)).toBe('01:24');
    expect(formatTime(0)).toBe('00:00');
  });
});

describe('geometry', () => {
  it('scales 1920 -> 960 by half', () => {
    expect(toDisplay([200, 100, 80, 40], 1920, 1080, 960, 540)).toEqual([100, 50, 40, 20]);
  });
  it('fromDisplay inverts toDisplay', () => {
    expect(fromDisplay([100, 50, 40, 20], 1920, 1080, 960, 540)).toEqual([200, 100, 80, 40]);
  });
  it('containRect letterboxes a wide video in a taller box', () => {
    expect(containRect(1920, 1080, 800, 600)).toEqual({ x: 0, y: 75, w: 800, h: 450 });
  });
  it('containRect pillarboxes a tall video in a wider box', () => {
    expect(containRect(1080, 1920, 800, 540)).toEqual({ x: 800 / 2 - 151.875 / 1, y: 0, w: 303.75, h: 540 });
  });
});
