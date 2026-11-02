import type { Region } from './types';

export const TILE_W = 80;
export const MIN_TILES = 8;
export const MAX_TILES = 40;

/** Number of filmstrip tiles for a content width (0 / unknown width -> MIN_TILES). */
export function tileCount(contentWidth: number): number {
  const n = Math.round(contentWidth / TILE_W);
  return Math.max(MIN_TILES, Math.min(MAX_TILES, Number.isFinite(n) ? n : MIN_TILES));
}

/** Frame shown by each of `n` evenly spaced tiles (the midpoint of each tile's span), clamped to the video. */
export function sampleFrames(frameCount: number, n: number): number[] {
  const last = Math.max(0, frameCount - 1);
  return Array.from({ length: n }, (_, i) => Math.max(0, Math.min(last, Math.round(((i + 0.5) / n) * frameCount))));
}

/** Smallest mosaic block on a thumbnail: a scaled 1-2px block would leave a tiny face recognizable. */
export const MIN_THUMB_BLOCK = 4;

/**
 * Scale source-pixel regions into thumbnail pixels. The box grows outward to whole pixels (never
 * smaller than the scaled box), polygon points scale and round, and the block size scales too
 * (min MIN_THUMB_BLOCK px). The effect and shape are kept.
 */
export function scaleRegions(regions: Region[], srcW: number, srcH: number, thumbW: number, thumbH: number): Region[] {
  const sx = thumbW / srcW;
  const sy = thumbH / srcH;
  return regions.map((r) => {
    const x0 = Math.floor(r.box[0] * sx);
    const y0 = Math.floor(r.box[1] * sy);
    const x1 = Math.ceil((r.box[0] + r.box[2]) * sx);
    const y1 = Math.ceil((r.box[1] + r.box[3]) * sy);
    return {
      ...r,
      box: [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)],
      points: r.points ? r.points.map(([px, py]): [number, number] => [Math.round(px * sx), Math.round(py * sy)]) : null,
      block: Math.max(MIN_THUMB_BLOCK, Math.round(r.block * Math.min(sx, sy))),
    };
  });
}

/**
 * Regions to draw on a thumbnail of `frame`. A seek may land on a neighbouring video frame, so the
 * regions of frame-1 and frame+1 are included too: a face must never show in a thumbnail.
 */
export function regionsForThumb(regions: Map<number, Region[]>, frame: number): Region[] {
  return [...(regions.get(frame - 1) ?? []), ...(regions.get(frame) ?? []), ...(regions.get(frame + 1) ?? [])];
}
