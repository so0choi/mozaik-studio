import type { Box } from './types';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Scale a source-pixel box into a display box of size dispW x dispH (no offset). */
export function toDisplay(box: Box, srcW: number, srcH: number, dispW: number, dispH: number): Box {
  const sx = dispW / srcW;
  const sy = dispH / srcH;
  return [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy];
}

export function fromDisplay(box: Box, srcW: number, srcH: number, dispW: number, dispH: number): Box {
  const sx = srcW / dispW;
  const sy = srcH / dispH;
  return [box[0] * sx, box[1] * sy, box[2] * sx, box[3] * sy];
}

/** Content rectangle of an `object-fit: contain` video inside an element of elemW x elemH. */
export function containRect(srcW: number, srcH: number, elemW: number, elemH: number): Rect {
  if (!srcW || !srcH || !elemW || !elemH) return { x: 0, y: 0, w: elemW, h: elemH };
  const scale = Math.min(elemW / srcW, elemH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (elemW - w) / 2, y: (elemH - h) / 2, w, h };
}

export function clampBox(box: Box, srcW: number, srcH: number): Box {
  const x = Math.max(0, Math.min(srcW - 1, box[0]));
  const y = Math.max(0, Math.min(srcH - 1, box[1]));
  const w = Math.max(1, Math.min(srcW - x, box[2]));
  const h = Math.max(1, Math.min(srcH - y, box[3]));
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}
