import type { MaskBox } from './types';

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

/** Scale source-pixel mask boxes into thumbnail pixels. The block size scales too (min MIN_THUMB_BLOCK px). */
export function scaleBoxes(boxes: MaskBox[], srcW: number, srcH: number, thumbW: number, thumbH: number): MaskBox[] {
  const sx = thumbW / srcW;
  const sy = thumbH / srcH;
  return boxes.map(([x, y, w, h, block]) => [x * sx, y * sy, w * sx, h * sy, Math.max(MIN_THUMB_BLOCK, block * Math.min(sx, sy))]);
}

/**
 * Boxes to pixelate on a thumbnail of `frame`. A seek may land on a neighbouring video frame, so the
 * boxes of frame-1 and frame+1 are included too: a face must never show in a thumbnail.
 */
export function boxesForThumb(masks: Map<number, MaskBox[]>, frame: number): MaskBox[] {
  return [...(masks.get(frame - 1) ?? []), ...(masks.get(frame) ?? []), ...(masks.get(frame + 1) ?? [])];
}
