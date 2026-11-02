import type { Shape } from './types';

/**
 * Pure shape rasterizer: a port of worker/mosaic_worker/shapes.py (shape_bitmap). Keep the two in sync;
 * both are checked against contracts/fixtures/shape-masks.json.
 *
 * Pixel (i, j) of the box is included when its center (i + 0.5, j + 0.5) is inside the shape.
 * Row-major Uint8Array (1 = included). `points` are relative to the box origin.
 * Polygons use NONZERO winding; a polygon with |area| < 1 px^2, or an empty raster whose points reach
 * into the box, is fully included (fail closed).
 * The optional `window` mirrors shape_bitmap's: only that sub-rectangle is rasterized.
 * A box smaller than MIN_SHAPE_SIZE in either direction, a polygon with fewer than 3 points and an
 * unknown shape are all fully included: a shape must never leave part of a box unmasked.
 */
export const MIN_SHAPE_SIZE = 4;

function shoelaceArea(points: [number, number][]): number {
  let a = 0;
  for (let k = 0; k < points.length; k++) {
    const [x1, y1] = points[k];
    const [x2, y2] = points[(k + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * `window` = [x0, y0, x1, y1] in box coordinates (default: the whole box): only that part is rasterized,
 * with the same per-pixel result as cropping the full bitmap, and the result is row-major
 * (y1 - y0) x (x1 - x0) after clamping to the box. The empty-raster fail-closed check is evaluated on the
 * window, exactly as in worker shape_bitmap.
 */
export function shapeBitmap(
  shape: Shape,
  w: number,
  h: number,
  points: [number, number][] | null,
  window: readonly [number, number, number, number] | null = null,
): Uint8Array {
  w = Math.max(0, Math.trunc(w));
  h = Math.max(0, Math.trunc(h));
  if (w === 0 || h === 0) return new Uint8Array(0);
  let [x0, y0, x1, y1] = window ? window.map((v) => Math.trunc(v)) : [0, 0, w, h];
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(w, x1);
  y1 = Math.min(h, y1);
  if (x1 <= x0 || y1 <= y0) return new Uint8Array(0);
  const ww = x1 - x0;
  const wh = y1 - y0;
  const out = new Uint8Array(ww * wh).fill(1);
  if (shape === 'rect' || w < MIN_SHAPE_SIZE || h < MIN_SHAPE_SIZE) return out;

  if (shape === 'ellipse') {
    const rx = w / 2;
    const ry = h / 2;
    for (let j = 0; j < wh; j++) {
      const dy = (y0 + j + 0.5 - ry) / ry;
      for (let i = 0; i < ww; i++) {
        const dx = (x0 + i + 0.5 - rx) / rx;
        out[j * ww + i] = dx * dx + dy * dy <= 1 ? 1 : 0;
      }
    }
    return out;
  }

  if (shape === 'polygon') {
    if (!points || points.length < 3 || shoelaceArea(points) < 1) return out;
    const winding = new Int32Array(ww * wh);
    const n = points.length;
    for (let k = 0; k < n; k++) {
      const [ax, ay] = points[k];
      const [bx, by] = points[(k + 1) % n];
      if (ay === by) continue;
      for (let j = 0; j < wh; j++) {
        const py = y0 + j + 0.5;
        const up = ay <= py && py < by;
        const down = by <= py && py < ay;
        if (!up && !down) continue;
        const xi = ax + ((py - ay) * (bx - ax)) / (by - ay);
        const dir = up ? 1 : -1;
        for (let i = 0; i < ww; i++) {
          if (x0 + i + 0.5 < xi) winding[j * ww + i] += dir;
        }
      }
    }
    let any = false;
    for (let i = 0; i < winding.length; i++) {
      const v = winding[i] !== 0 ? 1 : 0;
      out[i] = v;
      if (v) any = true;
    }
    if (!any) {
      const xs = points.map((p) => p[0]);
      const ys = points.map((p) => p[1]);
      // empty raster although the points reach into the window: fail closed (full window)
      if (Math.min(...xs) < x1 && Math.max(...xs) > x0 && Math.min(...ys) < y1 && Math.max(...ys) > y0) out.fill(1);
    }
    return out;
  }
  return out; // unknown shape: mask the whole box
}
