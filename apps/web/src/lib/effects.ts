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

/**
 * Whether canvas `filter` really blurs. Assigning `ctx.filter` and reading it back is NOT proof:
 * where the context has no accessor the assignment just creates a plain property. So require the
 * accessor on the prototype AND a one-time pixel probe: draw one opaque pixel through a blur and
 * see a neighbouring pixel become non-transparent. Any failure means false (blur is then skipped,
 * and the opaque mosaic underlay stays: the raw frame is never drawn for blur). Cached.
 */
export function supportsCanvasFilter(_ctx?: CanvasRenderingContext2D): boolean {
  if (filterSupport === null) {
    try {
      if (typeof CanvasRenderingContext2D === 'undefined' || !('filter' in CanvasRenderingContext2D.prototype)) {
        filterSupport = false;
      } else {
        const src = document.createElement('canvas');
        const dst = document.createElement('canvas');
        src.width = src.height = dst.width = dst.height = 5;
        const sctx = src.getContext('2d');
        const dctx = dst.getContext('2d');
        if (!sctx || !dctx) {
          filterSupport = false;
        } else {
          sctx.fillStyle = '#000';
          sctx.fillRect(2, 2, 1, 1);
          dctx.filter = 'blur(1px)';
          dctx.drawImage(src, 0, 0);
          dctx.filter = 'none';
          filterSupport = dctx.getImageData(1, 2, 1, 1).data[3] > 0;
        }
      }
    } catch {
      filterSupport = false;
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

/** Display box of a region rounded OUTWARD to whole pixels: no partially transparent outer pixel. */
function outward(r: Region, rect: Rect, srcW: number, srcH: number): [number, number, number, number] {
  const [dx, dy, dw, dh] = toDisplay(r.box, srcW, srcH, rect.w, rect.h);
  const x0 = Math.floor(rect.x + dx);
  const y0 = Math.floor(rect.y + dy);
  return [x0, y0, Math.ceil(rect.x + dx + dw) - x0, Math.ceil(rect.y + dy + dh) - y0];
}

/** The content rect rounded OUTWARD to whole pixels, so its outer pixels are fully covered (no alpha<255 edge row). */
function outwardRect(rect: Rect): Rect {
  const x0 = Math.floor(rect.x);
  const y0 = Math.floor(rect.y);
  return { x: x0, y: y0, w: Math.ceil(rect.x + rect.w) - x0, h: Math.ceil(rect.y + rect.h) - y0 };
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
  // whole-pixel rect: the background covers the outer pixel row/column of the fractional content rect
  const wr = outwardRect(rect);
  ctx.save();
  ctx.beginPath();
  ctx.rect(wr.x, wr.y, wr.w, wr.h);
  ctx.clip();
  try {
    if (eff.type === 'color') {
      ctx.fillStyle = eff.color;
      ctx.fillRect(wr.x, wr.y, wr.w, wr.h);
      return;
    }
    const vx = src.width / srcW;
    const vy = src.height / srcH;
    // opaque mosaic of the whole frame (also the blur fallback and the blur's underlay)
    const g = gridOf(srcW, srcH, backgroundBlock(srcW, srcH, eff.strength));
    off.width = g.cols;
    off.height = g.rows;
    mosaicInto(octx, src, [0, 0, srcW, srcH], g.block, vx, vy, g);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, g.cols, g.rows, wr.x, wr.y, wr.w, wr.h);
    if (eff.type === 'blur' && supportsCanvasFilter(octx)) {
      const qw = Math.max(1, Math.ceil(srcW / 4));
      const qh = Math.max(1, Math.ceil(srcH / 4));
      off.width = qw;
      off.height = qh;
      octx.filter = `blur(${backgroundSigma(srcW, srcH, eff.strength) / 4}px)`;
      octx.drawImage(src.image, 0, 0, src.width, src.height, 0, 0, qw, qh);
      octx.filter = 'none';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, qw, qh, wr.x, wr.y, wr.w, wr.h);
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
  const [ox, oy, ow, oh] = outward(r, rect, srcW, srcH);
  ctx.save();
  try {
    const wr = outwardRect(rect);
    ctx.beginPath();
    ctx.rect(wr.x, wr.y, wr.w, wr.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, w, h, ox, oy, ow, oh);
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
    const [ox, oy, ow, oh] = outward(r, rect, srcW, srcH);
    ctx.fillStyle = GREY;
    ctx.fillRect(ox, oy, ow, oh);
  };
  const octx = off.getContext('2d');
  if (!octx || !src.ready || !src.width || !src.height) {
    if (background) {
      const wr = outwardRect(rect);
      ctx.fillStyle = GREY;
      ctx.fillRect(wr.x, wr.y, wr.w, wr.h);
    }
    regions.forEach(grey);
    return;
  }
  if (background) {
    try {
      drawBackground(ctx, octx, src, off, background, rect, srcW, srcH);
    } catch {
      const wr = outwardRect(rect);
      ctx.fillStyle = GREY;
      ctx.fillRect(wr.x, wr.y, wr.w, wr.h);
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
