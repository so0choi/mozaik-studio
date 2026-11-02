import type { Shape } from './types';

/**
 * Pure shape rasterizer: a port of worker/mosaic_worker/shapes.py (shape_bitmap). Keep the two in sync;
 * both are checked against contracts/fixtures/shape-masks.json.
 *
 * Pixel (i, j) of the box is included when its center (i + 0.5, j + 0.5) is inside the shape.
 * Row-major Uint8Array (1 = included). `points` are relative to the box origin.
 * Polygons use NONZERO winding; a polygon with |area| < 1 px^2, or an empty raster whose points reach
 * into the box, is fully included (fail closed).
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

export function shapeBitmap(
  shape: Shape,
  w: number,
  h: number,
  points: [number, number][] | null,
): Uint8Array {
  w = Math.max(0, Math.trunc(w));
  h = Math.max(0, Math.trunc(h));
  const out = new Uint8Array(w * h).fill(1);
  if (w === 0 || h === 0 || shape === 'rect' || w < MIN_SHAPE_SIZE || h < MIN_SHAPE_SIZE) return out;

  if (shape === 'ellipse') {
    const rx = w / 2;
    const ry = h / 2;
    for (let j = 0; j < h; j++) {
      const dy = (j + 0.5 - ry) / ry;
      for (let i = 0; i < w; i++) {
        const dx = (i + 0.5 - rx) / rx;
        out[j * w + i] = dx * dx + dy * dy <= 1 ? 1 : 0;
      }
    }
    return out;
  }

  if (shape === 'polygon') {
    if (!points || points.length < 3 || shoelaceArea(points) < 1) return out;
    const winding = new Int32Array(w * h);
    const n = points.length;
    for (let k = 0; k < n; k++) {
      const [x1, y1] = points[k];
      const [x2, y2] = points[(k + 1) % n];
      if (y1 === y2) continue;
      for (let j = 0; j < h; j++) {
        const py = j + 0.5;
        const up = y1 <= py && py < y2;
        const down = y2 <= py && py < y1;
        if (!up && !down) continue;
        const xi = x1 + ((py - y1) * (x2 - x1)) / (y2 - y1);
        const dir = up ? 1 : -1;
        for (let i = 0; i < w; i++) {
          if (i + 0.5 < xi) winding[j * w + i] += dir;
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
      // empty raster although the points reach into the box: fail closed (full rect)
      if (Math.min(...xs) < w && Math.max(...xs) > 0 && Math.min(...ys) < h && Math.max(...ys) > 0) out.fill(1);
    }
    return out;
  }
  return out; // unknown shape: mask the whole box
}
