import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawFrameEffects, maskAlpha, resetFilterSupportCache, supportsCanvasFilter, type PixelSource } from './effects';
import { regionSigma } from './effectParams';
import { shapeBitmap } from './shapes';
import type { Effect, Region } from './types';

type Call = { fn: string; args: unknown[]; filter: string; op: string; canvas: string };
let calls: Call[];
let filterSupported: boolean;
let putData: Uint8ClampedArray[];
let protoHasFilter: boolean;

function fakeCtx(name: string): CanvasRenderingContext2D {
  let filter = 'none';
  let op = 'source-over';
  const log = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args, filter, op, canvas: name });
  };
  const target: Record<string, unknown> = {
    get filter() {
      return filterSupported ? filter : 'none';
    },
    set filter(v: string) {
      filter = v;
    },
    get globalCompositeOperation() {
      return op;
    },
    set globalCompositeOperation(v: string) {
      op = v;
    },
    fillStyle: '',
    imageSmoothingEnabled: true,
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, filterSupported ? 128 : 0]) }),
    putImageData: (img: { data: Uint8ClampedArray }, ...rest: unknown[]) => {
      putData.push(new Uint8ClampedArray(img.data));
      log('putImageData')(img, ...rest);
    },
  };
  for (const fn of ['drawImage', 'fillRect', 'save', 'restore', 'beginPath', 'rect', 'clip', 'clearRect']) target[fn] = log(fn);
  return target as unknown as CanvasRenderingContext2D;
}

const mosaic: Effect = { type: 'mosaic', strength: 1, color: '#000000' };
const blur: Effect = { type: 'blur', strength: 1, color: '#000000' };
const color: Effect = { type: 'color', strength: 1, color: '#102030' };
const rect = { x: 10, y: 20, w: 320, h: 180 }; // srcW 640 x srcH 360 -> scale 0.5
const region = (over: Partial<Region> = {}): Region => ({
  id: 'r', shape: 'rect', box: [100, 100, 64, 48], points: null, effect: mosaic, block: 8, ...over,
});
const ready: PixelSource = { image: {} as CanvasImageSource, width: 640, height: 360, ready: true };
const notReady: PixelSource = { ...ready, ready: false };

let ctx: CanvasRenderingContext2D;
let off: HTMLCanvasElement;

function run(regions: Region[], background: Effect | null = null, src = ready) {
  drawFrameEffects(ctx, src, off, regions, background, rect, 640, 360);
}
const idx = (pred: (c: Call) => boolean) => calls.findIndex(pred);

beforeEach(() => {
  calls = [];
  putData = [];
  filterSupported = true;
  protoHasFilter = true;
  vi.stubGlobal('CanvasRenderingContext2D', class {});
  resetFilterSupportCache();
  if (protoHasFilter) Object.defineProperty((globalThis as never as { CanvasRenderingContext2D: { prototype: object } }).CanvasRenderingContext2D.prototype, 'filter', { value: 'none', writable: true });
  const ctxs = new Map<HTMLCanvasElement, CanvasRenderingContext2D>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    if (!ctxs.has(this)) ctxs.set(this, fakeCtx(this === off ? 'off' : 'aux'));
    return ctxs.get(this)!;
  } as never);
  off = document.createElement('canvas');
  ctx = fakeCtx('main');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('not ready', () => {
  it('grey fill over every region box', () => {
    run([region(), region({ box: [0, 0, 20, 10] })], null, notReady);
    const fills = calls.filter((c) => c.fn === 'fillRect');
    expect(fills.map((c) => c.args)).toEqual([[60, 70, 32, 24], [10, 20, 10, 5]]);
    expect(calls.some((c) => c.fn === 'drawImage')).toBe(false);
  });

  it('background grey when not ready', () => {
    run([region()], blur, notReady);
    expect(calls[0]).toMatchObject({ fn: 'fillRect', args: [10, 20, 320, 180] });
    expect(calls.some((c) => c.fn === 'drawImage')).toBe(false);
  });
});

describe('background', () => {
  it('background drawn before regions', () => {
    run([region({ effect: color })], color);
    const bg = idx((c) => c.fn === 'fillRect' && c.args[2] === 320);
    const reg = idx((c) => c.fn === 'drawImage' && c.canvas === 'main' && (c.args[5] as number) === 60);
    expect(bg).toBeGreaterThanOrEqual(0);
    expect(reg).toBeGreaterThan(bg);
  });

  it('background color fills the whole content rect', () => {
    run([], color);
    expect(calls.find((c) => c.fn === 'fillRect')!.args).toEqual([10, 20, 320, 180]);
  });

  it('background blur goes through a quarter-size blurred layer over a mosaic underlay', () => {
    run([], blur);
    const q = calls.find((c) => c.canvas === 'off' && c.fn === 'drawImage' && c.filter.startsWith('blur'))!;
    expect(q.args.slice(5)).toEqual([0, 0, 160, 90]);
    expect(q.filter).toBe('blur(1.5px)');
    const under = idx((c) => c.canvas === 'main' && c.fn === 'drawImage');
    const over = calls.findIndex((c, i) => i > under && c.canvas === 'main' && c.fn === 'drawImage');
    expect(over).toBeGreaterThan(under);
  });

  it('background blur falls back to background mosaic without ctx.filter', () => {
    filterSupported = false;
    run([], blur);
    expect(calls.some((c) => c.canvas === 'off' && c.filter.startsWith('blur'))).toBe(false);
    const down = calls.find((c) => c.canvas === 'off' && c.fn === 'drawImage')!;
    // block = round(max(8, 360/40)) = 9 -> 72 x 40 grid
    expect(down.args.slice(5)).toEqual([0, 0, 72, 40]);
  });
});

describe('regions', () => {
  it('opaque mosaic underlay drawn before blur', () => {
    run([region({ effect: blur })]);
    const under = idx((c) => c.canvas === 'off' && c.fn === 'drawImage' && c.filter === 'none');
    const bl = idx((c) => c.canvas === 'off' && c.fn === 'drawImage' && c.filter.startsWith('blur'));
    expect(under).toBeGreaterThanOrEqual(0);
    expect(bl).toBeGreaterThan(under);
  });

  it('blur samples a margin of ceil(3σ) around the box', () => {
    const r = region({ effect: blur, box: [100, 100, 64, 48] });
    const sigma = regionSigma(64, 48, 1); // 12
    const m = Math.ceil(3 * sigma);
    run([r]);
    const bl = calls.find((c) => c.canvas === 'off' && c.fn === 'drawImage' && c.filter.startsWith('blur'))!;
    expect(bl.filter).toBe(`blur(${sigma}px)`);
    expect(bl.args.slice(1, 5)).toEqual([100 - m, 100 - m, 64 + 2 * m, 48 + 2 * m]);
    // destination keeps the box at (0,0) of the offscreen
    expect(bl.args.slice(5)).toEqual([-m, -m, 64 + 2 * m, 48 + 2 * m]);
  });

  it('blur margin is clamped to the frame', () => {
    const sigma = regionSigma(64, 48, 1);
    const m = Math.ceil(3 * sigma);
    run([region({ effect: blur, box: [4, 2, 64, 48] })]);
    const bl = calls.find((c) => c.canvas === 'off' && c.filter.startsWith('blur') && c.fn === 'drawImage')!;
    expect(bl.args.slice(1, 5)).toEqual([0, 0, 4 + 64 + m, 2 + 48 + m]);
    expect(bl.args.slice(5, 7)).toEqual([-4, -2]);
  });

  it('blur skipped when ctx.filter unsupported', () => {
    filterSupported = false;
    run([region({ effect: blur })]);
    expect(calls.some((c) => c.canvas !== 'aux' && c.filter.startsWith('blur'))).toBe(false);
    expect(calls.filter((c) => c.canvas === 'off' && c.fn === 'drawImage').length).toBeGreaterThan(0); // underlay
    expect(calls.some((c) => c.canvas === 'main' && c.fn === 'drawImage')).toBe(true);
  });

  it('color effect uses region color', () => {
    run([region({ effect: color })]);
    const fills = calls.filter((c) => c.canvas === 'off' && c.fn === 'fillRect');
    const f = fills[fills.length - 1]; // the first is the grey base of the mosaic underlay
    expect(f.args).toEqual([0, 0, 64, 48]);
    expect(calls.indexOf(f)).toBeGreaterThan(calls.map((c, i) => (c.canvas === 'off' && c.fn === 'drawImage' ? i : -1)).reduce((a, b) => Math.max(a, b), -1));
  });

  it('mask uses shapeBitmap alpha with destination-in', () => {
    const r = region({ shape: 'ellipse', box: [100, 100, 41, 31] });
    run([r]);
    expect(putData).toHaveLength(1);
    const bm = shapeBitmap('ellipse', 41, 31, null);
    expect(Array.from(putData[0].filter((_, i) => i % 4 === 3))).toEqual(Array.from(bm, (v) => (v ? 255 : 0)));
    const di = calls.find((c) => c.canvas === 'off' && c.fn === 'drawImage' && c.op === 'destination-in');
    expect(di).toBeDefined();
    // composite mode is restored before the final display draw
    const final = calls.find((c) => c.canvas === 'main' && c.fn === 'drawImage')!;
    expect(final.args.slice(5)).toEqual([60, 70, 21, 16]);
  });

  it('polygon points are made relative to the box origin', () => {
    const pts: [number, number][] = [[110, 105], [150, 105], [130, 140]];
    run([region({ shape: 'polygon', box: [100, 100, 64, 48], points: pts })]);
    const bm = shapeBitmap('polygon', 64, 48, [[10, 5], [50, 5], [30, 40]]);
    expect(Array.from(putData[0].filter((_, i) => i % 4 === 3))).toEqual(Array.from(bm, (v) => (v ? 255 : 0)));
  });

  it('scales to display without smoothing', () => {
    run([region()]);
    const final = calls.find((c) => c.canvas === 'main' && c.fn === 'drawImage')!;
    expect(final.args.slice(1)).toEqual([0, 0, 64, 48, 60, 70, 32, 24]);
  });
});

describe('maskAlpha', () => {
  it('writes alpha strictly 0 or 255 and leaves rgb zero', () => {
    const d = maskAlpha(new Uint8Array([1, 0, 0, 1]));
    expect(Array.from(d)).toEqual([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255]);
  });
});

describe('supportsCanvasFilter', () => {
  it('true when the pixel probe sees a blurred neighbour; cached; reset hook re-probes', () => {
    expect(supportsCanvasFilter(ctx)).toBe(true);
    filterSupported = false;
    expect(supportsCanvasFilter(ctx)).toBe(true); // cached
    resetFilterSupportCache();
    expect(supportsCanvasFilter(ctx)).toBe(false);
  });

  it('false for an expando filter property: assignment reads back but nothing blurs', () => {
    filterSupported = false; // probe pixels stay transparent
    (ctx as unknown as { filter: string }).filter = 'blur(1px)';
    expect(supportsCanvasFilter(ctx)).toBe(false);
  });

  it('false when the context prototype has no filter accessor', () => {
    vi.stubGlobal('CanvasRenderingContext2D', class {});
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'fill', { value: 1 });
    // fresh class: no 'filter'
    resetFilterSupportCache();
    expect(supportsCanvasFilter(ctx)).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('false when the probe throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
      throw new Error('x');
    });
    expect(supportsCanvasFilter(ctx)).toBe(false);
  });
});

describe('outward rounding', () => {
  it('display draw rect and grey fill are integers rounded outward at a fractional scale', () => {
    const r = region({ box: [101, 101, 64, 47] }); // scale 0.5 -> 60.5, 70.5, 31.5 x 23.5
    run([r]);
    const final = calls.find((c) => c.canvas === 'main' && c.fn === 'drawImage')!;
    expect(final.args.slice(5)).toEqual([60, 70, 33, 24]); // x 60.5..92.5 -> 60..93
    run([r], null, notReady);
    const fill = calls.filter((c) => c.fn === 'fillRect').pop()!;
    expect(fill.args).toEqual(final.args.slice(5));
  });
});
