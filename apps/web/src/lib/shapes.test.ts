import { describe, expect, it } from 'vitest';
import { shapeMaskCases, softEllipseCases } from './fixtures';
import { SOFT_EDGE, faceEllipseBox, shapeBitmap, softEllipseAlpha, softExtent } from './shapes';

function rows(bm: Uint8Array, w: number, h: number): string[] {
  return Array.from({ length: h }, (_, j) => Array.from(bm.slice(j * w, (j + 1) * w)).join(''));
}

describe('shapeBitmap', () => {
  it('matches shared shape masks', () => {
    expect(shapeMaskCases.length).toBeGreaterThan(0);
    for (const c of shapeMaskCases) {
      const win = c.window ?? null;
      const ww = win ? Math.max(0, Math.min(c.w, win[2]) - Math.max(0, win[0])) : c.w;
      const wh = win ? Math.max(0, Math.min(c.h, win[3]) - Math.max(0, win[1])) : c.h;
      expect(rows(shapeBitmap(c.shape, c.w, c.h, c.points, win), ww, wh), c.name).toEqual(c.rows);
    }
  });

  it('never leaves a tiny, degenerate or unknown shape unmasked', () => {
    expect(Array.from(shapeBitmap('ellipse', 3, 9, null)).every((v) => v === 1)).toBe(true);
    expect(Array.from(shapeBitmap('polygon', 8, 8, [[0, 0], [7, 7]])).every((v) => v === 1)).toBe(true);
    expect(Array.from(shapeBitmap('polygon', 8, 8, null)).every((v) => v === 1)).toBe(true);
    expect(Array.from(shapeBitmap('star' as never, 8, 8, null)).every((v) => v === 1)).toBe(true);
  });
});

describe('soft ellipse (blur on ellipse regions)', () => {
  it('matches the shared soft-ellipse-alpha fixture', () => {
    expect(softEllipseCases.length).toBeGreaterThanOrEqual(2);
    for (const c of softEllipseCases) {
      const [x, y, w, h] = c.box;
      for (const [px, py, want] of c.samples) {
        const a = softEllipseAlpha(w, h, [px - x, py - y, px - x + 1, py - y + 1])[0];
        expect(Math.round(a * 255), `${c.name} ${px},${py}`).toBe(want);
      }
    }
  });

  it('face ellipse geometry from a stored box', () => {
    expect(faceEllipseBox([100, 50, 80, 60])).toEqual([94, 45, 93, 70]);
  });

  it('core equals the hard ellipse, band is strictly between 0 and 1, outside is exactly 0', () => {
    const w = 41;
    const h = 31;
    const [x0, y0, x1, y1] = softExtent(w, h);
    const a = softEllipseAlpha(w, h, [x0, y0, x1, y1]);
    const hard = shapeBitmap('ellipse', w, h, null);
    const ew = x1 - x0;
    let band = false;
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) {
        const v = a[(j - y0) * ew + (i - x0)];
        const inside = i >= 0 && i < w && j >= 0 && j < h;
        if (inside && hard[j * w + i]) expect(v).toBe(1);
        const r = Math.hypot((i + 0.5 - w / 2) / (w / 2), (j + 0.5 - h / 2) / (h / 2));
        if (r >= 1 + SOFT_EDGE) expect(v).toBe(0);
        else if (r > 1) {
          expect(v).toBeLessThan(1);
          if (v > 0) band = true;
        }
      }
    }
    expect(band).toBe(true);
  });

  it('SAFETY: every pixel of the raw box (stored / 1.25) is fully covered', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 0; n < 60; n++) {
      const w = 8 + Math.floor(rnd() * 150);
      const h = 8 + Math.floor(rnd() * 150);
      const x = Math.floor(rnd() * 300);
      const y = Math.floor(rnd() * 300);
      const rw = w / 1.25;
      const rh = h / 1.25;
      const rx0 = x + (w - rw) / 2;
      const ry0 = y + (h - rh) / 2;
      const [ex, ey, ew, eh] = faceEllipseBox([x, y, w, h]);
      const win: [number, number, number, number] = [
        Math.ceil(rx0) - ex, Math.ceil(ry0) - ey, Math.floor(rx0 + rw) - ex, Math.floor(ry0 + rh) - ey,
      ];
      const a = softEllipseAlpha(ew, eh, win);
      expect(a.every((v) => v === 1), `${x},${y},${w},${h}`).toBe(true);
    }
  });
});
