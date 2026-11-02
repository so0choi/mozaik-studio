import type { Rect } from './geometry';
import { toDisplay } from './geometry';
import { backgroundBlock, backgroundSigma, regionSigma } from './effectParams';
import { shapeBitmap } from './shapes';
import type { Effect, Region } from './types';

/** An image the mask is sampled from. `ready` is false while no frame can be decodable. */
export interface PixelSource {
  image: CanvasImageSource;
  width: number;
  height: number;
  ready: boolean;
}

const GREY = '#6b6f7a';

let filterSupport: boolean | null = null;

/** Whether `ctx.filter = 'blur(..)'` takes effect (not in every browser). Probed once, then cached. */
export function supportsCanvasFilter(ctx: CanvasRenderingContext2D): boolean {
  if (filterSupport === null) {
    try {
      ctx.filter = 'blur(1px)';
      filterSupport = ctx.filter === 'blur(1px)';
    } catch {
      filterSupport = false;
    }
    try {
      ctx.filter = 'none';
    } catch {
      /* nothing to restore */
    }
  }
  return filterSupport;
}

/** Test hook: forget the cached ctx.filter probe. */
export function resetFilterSupportCache(): void {
  filterSupport = null;
}

/** RGBA pixels of a shape mask: alpha is strictly 0 or 255, rgb 0. Used with 'destination-in'. */
export function maskAlpha(bitmap: Uint8Array): Uint8ClampedArray {
  const data = new Uint8ClampedArray(bitmap.length * 4);
  for (let i = 0; i < bitmap.length; i++) data[i * 4 + 3] = bitmap[i] ? 255 : 0;
  return data;
}

const maskCanvases = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
function maskCanvasFor(off: HTMLCanvasElement): HTMLCanvasElement {
  let m = maskCanvases.get(off);
  if (!m) {
    m = off.ownerDocument.createElement('canvas');
    maskCanvases.set(off, m);
  }
  return m;
}

/**
 * Downscale `box` (source pixels, grid origin = its top-left, block in source pixels) of the frame
 * into the top-left cols x rows cells of `off`. The caller enlarges them with smoothing off.
 */
function mosaicInto(
  octx: CanvasRenderingContext2D,
  src: PixelSource,
  box: readonly [number, number, number, number],
  block: number,
  vx: number,
  vy: number,
  grid: { cols: number; rows: number },
): void {
  const [x, y] = box;
  const { cols, rows } = grid;
  // Opaque base: a cell the source rect cannot fully cover (box at the frame edge) is never transparent.
  octx.fillStyle = GREY;
  octx.fillRect(0, 0, cols, rows);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(src.image, x * vx, y * vy, cols * block * vx, rows * block * vy, 0, 0, cols, rows);
}

function gridOf(w: number, h: number, block: number) {
  const b = Math.max(1, block);
  return { cols: Math.max(1, Math.ceil(w / b)), rows: Math.max(1, Math.ceil(h / b)), block: b };
}

function drawBackground(
  ctx: CanvasRenderingContext2D,
  octx: CanvasRenderingContext2D,
  src: PixelSource,
  off: HTMLCanvasElement,
  eff: Effect,
  rect: Rect,
  srcW: number,
  srcH: number,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.w, rect.h);
  ctx.clip();
  try {
    if (eff.type === 'color') {
      ctx.fillStyle = eff.color;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      return;
    }
    const vx = src.width / srcW;
    const vy = src.height / srcH;
    const sx = rect.w / srcW;
    const sy = rect.h / srcH;
    // opaque mosaic of the whole frame (also the blur fallback and the blur's underlay)
    const g = gridOf(srcW, srcH, backgroundBlock(srcW, srcH, eff.strength));
    off.width = g.cols;
    off.height = g.rows;
    mosaicInto(octx, src, [0, 0, srcW, srcH], g.block, vx, vy, g);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, g.cols, g.rows, rect.x, rect.y, g.cols * g.block * sx, g.rows * g.block * sy);
    if (eff.type === 'blur' && supportsCanvasFilter(octx)) {
      const qw = Math.max(1, Math.ceil(srcW / 4));
      const qh = Math.max(1, Math.ceil(srcH / 4));
      off.width = qw;
      off.height = qh;
      octx.filter = `blur(${backgroundSigma(srcW, srcH, eff.strength) / 4}px)`;
      octx.drawImage(src.image, 0, 0, src.width, src.height, 0, 0, qw, qh);
      octx.filter = 'none';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, qw, qh, rect.x, rect.y, rect.w, rect.h);
    }
  } finally {
    ctx.restore();
  }
}

/**
 * One region: opaque mosaic underlay -> effect -> shape alpha ('destination-in') -> display.
 * The offscreen is in SOURCE pixels, so the shape bitmap maps 1:1; it is scaled to the display with
 * smoothing off. Every step starts from an opaque layer: no path leaves the raw frame visible.
 */
function drawRegion(
  ctx: CanvasRenderingContext2D,
  octx: CanvasRenderingContext2D,
  src: PixelSource,
  off: HTMLCanvasElement,
  r: Region,
  rect: Rect,
  srcW: number,
  srcH: number,
): void {
  const [x, y, w, h] = r.box;
  if (w <= 0 || h <= 0) return;
  const vx = src.width / srcW;
  const vy = src.height / srcH;
  const eff = r.effect;

  // (1) opaque mosaic underlay with the region's own block
  const g = gridOf(w, h, r.block);
  off.width = Math.max(w, g.cols);
  off.height = Math.max(h, g.rows);
  mosaicInto(octx, src, r.box, g.block, vx, vy, g);
  octx.imageSmoothingEnabled = false;
  octx.drawImage(off, 0, 0, g.cols, g.rows, 0, 0, g.cols * g.block, g.rows * g.block);

  // (2) effect over it
  if (eff.type === 'blur') {
    if (supportsCanvasFilter(octx)) {
      const sigma = regionSigma(w, h, eff.strength);
      const m = Math.ceil(3 * sigma);
      const x0 = Math.max(0, x - m);
      const y0 = Math.max(0, y - m);
      const x1 = Math.min(srcW, x + w + m);
      const y1 = Math.min(srcH, y + h + m);
      octx.filter = `blur(${sigma}px)`;
      // the box lands at (0, 0); the margin falls off the canvas but is seen by the blur
      octx.drawImage(src.image, x0 * vx, y0 * vy, (x1 - x0) * vx, (y1 - y0) * vy, x0 - x, y0 - y, x1 - x0, y1 - y0);
      octx.filter = 'none';
    }
  } else if (eff.type === 'color') {
    octx.fillStyle = eff.color;
    octx.fillRect(0, 0, w, h);
  }

  // (3) shape alpha, strictly 0 / 255
  if (r.shape !== 'rect') {
    const pts = r.points ? r.points.map(([px, py]): [number, number] => [px - x, py - y]) : null;
    const bm = shapeBitmap(r.shape, w, h, pts);
    const mask = maskCanvasFor(off);
    mask.width = w;
    mask.height = h;
    const mctx = mask.getContext('2d');
    if (!mctx) throw new Error('no mask canvas');
    const img = mctx.createImageData(w, h);
    img.data.set(maskAlpha(bm));
    mctx.putImageData(img, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(mask, 0, 0);
    octx.globalCompositeOperation = 'source-over';
  }

  // (4) to the display, nearest neighbour, never outside the content rect
  const [dx, dy, dw, dh] = toDisplay([x, y, w, h], srcW, srcH, rect.w, rect.h);
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, w, h, rect.x + dx, rect.y + dy, dw, dh);
  } finally {
    ctx.restore();
  }
}

/**
 * Draw the background (whole content rect) and then every region onto `ctx`, inside `rect` (the
 * displayed content rect). Regions are always computed from the ORIGINAL frame. If the frame is not
 * decodable, the background and each region box are filled grey: the raw area is never shown.
 */
export function drawFrameEffects(
  ctx: CanvasRenderingContext2D,
  src: PixelSource,
  off: HTMLCanvasElement,
  regions: Region[],
  background: Effect | null,
  rect: Rect,
  srcW: number,
  srcH: number,
): void {
  const grey = (r: Region) => {
    const [dx, dy, dw, dh] = toDisplay(r.box, srcW, srcH, rect.w, rect.h);
    ctx.fillStyle = GREY;
    ctx.fillRect(rect.x + dx, rect.y + dy, dw, dh);
  };
  const octx = off.getContext('2d');
  if (!octx || !src.ready || !src.width || !src.height) {
    if (background) {
      ctx.fillStyle = GREY;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
    regions.forEach(grey);
    return;
  }
  if (background) {
    try {
      drawBackground(ctx, octx, src, off, background, rect, srcW, srcH);
    } catch {
      ctx.fillStyle = GREY;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    }
  }
  for (const r of regions) {
    try {
      drawRegion(ctx, octx, src, off, r, rect, srcW, srcH);
    } catch {
      grey(r);
    }
  }
}
