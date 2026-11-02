import { memo, useEffect, useRef, useState } from 'react';
import { boxesForThumb, sampleFrames, scaleBoxes, tileCount } from '../lib/filmstrip';
import { pixelate } from '../lib/pixelate';
import type { MaskBox } from '../lib/types';

const THUMB_W = 96;
const SEEK_TIMEOUT_MS = 4000;

interface Props {
  src: string;
  masks: Map<number, MaskBox[]>;
  srcW: number;
  srcH: number;
  fps: number;
  frameCount: number;
  /** rendered width of the timeline content in px (0 when unknown) */
  contentWidth: number;
}

/** Seek `v` to `t` and resolve true once a frame is presented (false on error/timeout/abort). */
function seekTo(v: HTMLVideoElement, t: number, signal: { aborted: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
      resolve(ok && !signal.aborted);
    };
    const onSeeked = () => finish(v.readyState >= 2);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), SEEK_TIMEOUT_MS);
    const poll = setInterval(() => signal.aborted && finish(false), 200);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    try {
      v.currentTime = t;
    } catch {
      finish(false);
    }
  });
}

/**
 * Row of thumbnails. Raw frames are decoded into OFF-SCREEN canvases only; what is shown is always a
 * copy on which every mask box has been pixelated (re-drawn whenever the masks change). An
 * undecodable frame stays a grey tile.
 */
function FilmstripInner({ src, masks, srcW, srcH, fps, frameCount, contentWidth }: Props) {
  const n = tileCount(contentWidth);
  const [wantN, setWantN] = useState(n);
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [rawVersion, setRawVersion] = useState(0);
  const raws = useRef<(HTMLCanvasElement | null)[]>([]);
  const rawKey = useRef('');
  const thumbH = Math.max(1, Math.round((THUMB_W * srcH) / Math.max(1, srcW)));

  // debounce tile-count changes (zoom slider drags)
  useEffect(() => {
    const t = setTimeout(() => setWantN(n), 250);
    return () => clearTimeout(t);
  }, [n]);

  // extract raw frames, sequentially, into off-screen canvases
  useEffect(() => {
    if (typeof document === 'undefined' || !frameCount || !srcW || !srcH) return;
    const key = `${src}|${wantN}|${fps}|${frameCount}|${srcW}x${srcH}`;
    if (rawKey.current === key) return;
    rawKey.current = key;
    raws.current = Array.from({ length: wantN }, () => null);
    setUrls(Array.from({ length: wantN }, () => null));
    const signal = { aborted: false };
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.playsInline = true;
    v.src = src;
    void (async () => {
      const frames = sampleFrames(frameCount, wantN);
      for (let i = 0; i < frames.length; i++) {
        if (signal.aborted) return;
        const ok = await seekTo(v, frames[i] / fps, signal);
        if (signal.aborted) return;
        if (!ok || !v.videoWidth) continue;
        const c = document.createElement('canvas');
        c.width = THUMB_W;
        c.height = thumbH;
        const ctx = c.getContext('2d');
        if (!ctx) return; // no canvas support: keep placeholders
        try {
          ctx.drawImage(v, 0, 0, THUMB_W, thumbH);
        } catch {
          continue;
        }
        raws.current[i] = c;
        setRawVersion((x) => x + 1);
      }
    })();
    return () => {
      signal.aborted = true;
      rawKey.current = '';
      v.removeAttribute('src');
      v.load();
    };
  }, [src, wantN, fps, frameCount, srcW, srcH, thumbH]);

  // (re)compose the visible thumbnails: cached raw frame + CURRENT masks, pixelated
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const frames = sampleFrames(frameCount, wantN);
    const off = document.createElement('canvas');
    const out: (string | null)[] = frames.map((f, i) => {
      const raw = raws.current[i];
      if (!raw) return null;
      const c = document.createElement('canvas');
      c.width = THUMB_W;
      c.height = thumbH;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(raw, 0, 0);
      const boxes = scaleBoxes(boxesForThumb(masks, f), srcW, srcH, THUMB_W, thumbH);
      const source = { image: raw, width: THUMB_W, height: thumbH, ready: true };
      for (const b of boxes) pixelate(ctx, source, off, b, { x: 0, y: 0, w: THUMB_W, h: thumbH }, THUMB_W, thumbH);
      try {
        return c.toDataURL('image/jpeg', 0.7);
      } catch {
        return null; // never fall back to the raw frame
      }
    });
    setUrls(out);
  }, [masks, rawVersion, wantN, frameCount, srcW, srcH, thumbH]);

  return (
    <div className="film" aria-hidden="true" data-testid="filmstrip">
      {Array.from({ length: wantN }, (_, i) => (
        <div className="ft" key={i}>
          {urls[i] ? <img src={urls[i]!} alt="" draggable={false} /> : null}
        </div>
      ))}
    </div>
  );
}

export const Filmstrip = memo(FilmstripInner);
