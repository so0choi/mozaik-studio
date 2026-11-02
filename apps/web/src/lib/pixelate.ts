import type { Rect } from './geometry';
import { toDisplay } from './geometry';
import type { MaskBox } from './types';

/** An image the mask is sampled from. `ready` is false while no frame can be decoded. */
export interface PixelSource {
  image: CanvasImageSource;
  width: number;
  height: number;
  ready: boolean;
}

const GREY = '#6b6f7a';

/**
 * Draw one mosaic block grid for `b` (source pixels) onto `ctx`, inside `rect` (the displayed
 * content rect). Sampling grid origin = box top-left in SOURCE pixels, block size in source pixels.
 * If the frame is not decodable the box is filled grey: the raw area is never shown.
 */
export function pixelate(
  ctx: CanvasRenderingContext2D,
  src: PixelSource,
  off: HTMLCanvasElement,
  b: MaskBox,
  rect: Rect,
  srcW: number,
  srcH: number,
): void {
  const [x, y, w, h, block] = b;
  const [dx, dy, dw, dh] = toDisplay([x, y, w, h], srcW, srcH, rect.w, rect.h);
  const ox = rect.x + dx;
  const oy = rect.y + dy;
  const octx = off.getContext('2d');
  if (!octx || !src.ready || !src.width) {
    ctx.fillStyle = GREY;
    ctx.fillRect(ox, oy, dw, dh);
    return;
  }
  const cols = Math.max(1, Math.ceil(w / block));
  const rows = Math.max(1, Math.ceil(h / block));
  off.width = cols;
  off.height = rows;
  const vx = src.width / srcW;
  const vy = src.height / srcH;
  try {
    octx.drawImage(src.image, x * vx, y * vy, cols * block * vx, rows * block * vy, 0, 0, cols, rows);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, dw, dh);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    const sx = rect.w / srcW;
    const sy = rect.h / srcH;
    ctx.drawImage(off, 0, 0, cols, rows, ox, oy, cols * block * sx, rows * block * sy);
    ctx.restore();
  } catch {
    ctx.fillStyle = GREY;
    ctx.fillRect(ox, oy, dw, dh);
  }
}
