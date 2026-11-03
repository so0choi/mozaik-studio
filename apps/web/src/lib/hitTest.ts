import type { Region } from './types';

function inPolygon(pts: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(a) / 2;
}

function contains(r: Region, x: number, y: number): boolean {
  const [bx, by, bw, bh] = r.box;
  if (bw <= 0 || bh <= 0) return false;
  if (r.shape === 'polygon' && r.points && r.points.length >= 3) return inPolygon(r.points, x, y);
  if (x < bx || y < by || x > bx + bw || y > by + bh) return false;
  if (r.shape === 'ellipse') {
    const dx = (x - (bx + bw / 2)) / (bw / 2);
    const dy = (y - (by + bh / 2)) / (bh / 2);
    return dx * dx + dy * dy <= 1;
  }
  return true;
}

function area(r: Region): number {
  if (r.shape === 'polygon' && r.points && r.points.length >= 3) return polyArea(r.points);
  if (r.shape === 'ellipse') return (Math.PI * r.box[2] * r.box[3]) / 4;
  return r.box[2] * r.box[3];
}

/** The masked region under a source-pixel point; the smallest one when several overlap. */
export function regionAt(regions: Region[] | undefined, x: number, y: number): Region | null {
  let best: Region | null = null;
  let bestArea = Infinity;
  for (const r of regions ?? []) {
    if (!contains(r, x, y)) continue;
    const a = area(r);
    if (a < bestArea) {
      best = r;
      bestArea = a;
    }
  }
  return best;
}
