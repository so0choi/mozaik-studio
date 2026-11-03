import type { Rect } from './geometry';
import { toDisplay } from './geometry';
import { backgroundBlock, backgroundSigma, regionSigma } from './effectParams';
import { MIN_SHAPE_SIZE, shapeBitmap, softEllipseAlpha, softExtent } from './shapes';
import type { Effect, Region } from './types';

/** An image the mask is sampled from. `ready` is false while no frame can be decodable. */
export interface PixelSource {
  image: CanvasImageSource;
  width: number;
  height: number;
  ready: boolean;
}

const GREY = '#6b6f7a';
/** A frame-visible window above this many pixels is not drawn for the preview (grey fallback). */
const MAX_WINDOW_PIXELS = 8192 * 8192;

let filterSupport: boolean | null = null;

/**
 * Whether canvas `filter` really blurs. Assigning `ctx.filter` and reading it back is NOT proof:
 * where the context has no accessor the assignment just creates a plain property. So require the
 * accessor on the prototype AND a one-time pixel probe: draw one opaque pixel through a blur and
 * see a neighbouring pixel become non-transparent. Any failure means false (blur is then skipped,
 * and the opaque mosaic underlay stays: the raw frame is never drawn for blur). Cached.
 */
export function supportsCanvasFilter(): boolean {
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
 * Downscale the cols x rows grid cells (block source pixels each) whose top-left cell starts at
 * source pixel (sx, sy) into the top-left cols x rows pixels of `off`. The caller enlarges them with
 * smoothing off.
 */
function mosaicInto(
  octx: CanvasRenderingContext2D,
  src: PixelSource,
  sx: number,
  sy: number,
  block: number,
  vx: number,
  vy: number,
  grid: { cols: number; rows: number },
): void {
  const { cols, rows } = grid;
  // Opaque base: a cell the source rect cannot fully cover (box at the frame edge) is never transparent.
  octx.fillStyle = GREY;
  octx.fillRect(0, 0, cols, rows);
  octx.imageSmoothingEnabled = true;
  octx.drawImage(src.image, sx * vx, sy * vy, cols * block * vx, rows * block * vy, 0, 0, cols, rows);
}

/** Display box of a region rounded OUTWARD to whole pixels: no partially transparent outer pixel. */
function outward(
  box: readonly [number, number, number, number],
  rect: Rect,
  srcW: number,
  srcH: number,
): [number, number, number, number] {
  const [dx, dy, dw, dh] = toDisplay([box[0], box[1], box[2], box[3]], srcW, srcH, rect.w, rect.h);
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
    mosaicInto(octx, src, 0, 0, g.block, vx, vy, g);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, g.cols, g.rows, wr.x, wr.y, wr.w, wr.h);
    if (eff.type === 'blur' && supportsCanvasFilter()) {
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
  // only the frame-visible part of the box is ever drawn: canvases are sized from this window, never
  // from the (possibly huge or far off-frame) box
  // a blurred ellipse also draws its soft band: the window is the box grown by SOFT_EDGE
  const soft = r.effect.type === 'blur' && r.shape === 'ellipse' && w >= MIN_SHAPE_SIZE && h >= MIN_SHAPE_SIZE;
  const [sx0, sy0, sx1, sy1] = soft ? softExtent(w, h) : [0, 0, w, h];
  const wx0 = Math.max(0, x + sx0);
  const wy0 = Math.max(0, y + sy0);
  const wx1 = Math.min(srcW, x + sx1);
  const wy1 = Math.min(srcH, y + sy1);
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  if (!(ww > 0) || !(wh > 0)) throw new Error('region outside the frame');
  if (ww * wh > MAX_WINDOW_PIXELS) throw new Error('region window too large');
  const ox0 = wx0 - x; // window origin inside the box
  const oy0 = wy0 - y;
  const vx = src.width / srcW;
  const vy = src.height / srcH;
  const eff = r.effect;

  off.width = ww;
  off.height = wh;
  if (off.width !== ww || off.height !== wh) throw new Error('canvas allocation failed');

  // (1) opaque mosaic underlay with the region's own block; the grid origin is the BOX top-left
  const b = Math.max(1, r.block);
  const c0 = Math.floor(ox0 / b);
  const r0 = Math.floor(oy0 / b);
  const g = {
    cols: Math.max(1, Math.ceil((ox0 + ww) / b) - c0),
    rows: Math.max(1, Math.ceil((oy0 + wh) / b) - r0),
  };
  mosaicInto(octx, src, x + c0 * b, y + r0 * b, b, vx, vy, g);
  octx.imageSmoothingEnabled = false;
  octx.drawImage(off, 0, 0, g.cols, g.rows, c0 * b - ox0, r0 * b - oy0, g.cols * b, g.rows * b);

  // (2) effect over it
  if (eff.type === 'blur') {
    if (supportsCanvasFilter()) {
      const sigma = regionSigma(w, h, eff.strength);
      const m = Math.ceil(3 * sigma);
      const bx0 = Math.max(0, wx0 - m);
      const by0 = Math.max(0, wy0 - m);
      const bx1 = Math.min(srcW, wx1 + m);
      const by1 = Math.min(srcH, wy1 + m);
      octx.filter = `blur(${sigma}px)`;
      // the window lands at (0, 0); the margin falls off the canvas but is seen by the blur
      octx.drawImage(src.image, bx0 * vx, by0 * vy, (bx1 - bx0) * vx, (by1 - by0) * vy, bx0 - wx0, by0 - wy0, bx1 - bx0, by1 - by0);
      octx.filter = 'none';
    }
  } else if (eff.type === 'color') {
    octx.fillStyle = eff.color;
    octx.fillRect(0, 0, ww, wh);
  }

  // (3) shape alpha: strictly 0 / 255, except the soft band of a blurred ellipse (same alpha as the render)
  if (soft) {
    const a = softEllipseAlpha(w, h, [ox0, oy0, ox0 + ww, oy0 + wh]);
    const data = new Uint8ClampedArray(a.length * 4);
    for (let i = 0; i < a.length; i++) data[i * 4 + 3] = Math.round(a[i] * 255);
    const mask = maskCanvasFor(off);
    mask.width = ww;
    mask.height = wh;
    if (mask.width !== ww || mask.height !== wh) throw new Error('canvas allocation failed');
    const mctx = mask.getContext('2d');
    if (!mctx) throw new Error('no mask canvas');
    const img = mctx.createImageData(ww, wh);
    img.data.set(data);
    mctx.putImageData(img, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(mask, 0, 0);
    octx.globalCompositeOperation = 'source-over';
  } else if (r.shape !== 'rect') {
    const pts = r.points ? r.points.map(([px, py]): [number, number] => [px - x, py - y]) : null;
    const bm = shapeBitmap(r.shape, w, h, pts, [ox0, oy0, ox0 + ww, oy0 + wh]);
    const mask = maskCanvasFor(off);
    mask.width = ww;
    mask.height = wh;
    if (mask.width !== ww || mask.height !== wh) throw new Error('canvas allocation failed');
    const mctx = mask.getContext('2d');
    if (!mctx) throw new Error('no mask canvas');
    const img = mctx.createImageData(ww, wh);
    img.data.set(maskAlpha(bm));
    mctx.putImageData(img, 0, 0);
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(mask, 0, 0);
    octx.globalCompositeOperation = 'source-over';
  }

  // (4) to the display, nearest neighbour, never outside the content rect
  const [dxo, dyo, dwo, dho] = outward([wx0, wy0, ww, wh], rect, srcW, srcH);
  ctx.save();
  try {
    const wr = outwardRect(rect);
    ctx.beginPath();
    ctx.rect(wr.x, wr.y, wr.w, wr.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, ww, wh, dxo, dyo, dwo, dho);
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
    const [ox, oy, ow, oh] = outward(r.box, rect, srcW, srcH);
    const wr = outwardRect(rect);
    ctx.save();
    try {
      ctx.beginPath(); // an off-frame region must never paint into the letterbox
      ctx.rect(wr.x, wr.y, wr.w, wr.h);
      ctx.clip();
      ctx.fillStyle = GREY;
      ctx.fillRect(ox, oy, ow, oh);
    } finally {
      ctx.restore();
    }
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
