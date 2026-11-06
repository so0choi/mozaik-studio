import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { frameAt } from '../lib/frames';
import { containRect, toDisplay, type Rect } from '../lib/geometry';
import { drawFrameEffects } from '../lib/effects';
import { debugTime, type DebugBox, type DebugKind } from '../lib/debugBoxes';
import type { Box, Effect, Region } from '../lib/types';

export interface Highlight {
  box: Box;
  startFrame: number;
  endFrame: number;
}

interface Props {
  src: string;
  videoRef: RefObject<HTMLVideoElement>;
  srcW: number;
  srcH: number;
  fps: number;
  frameCount: number;
  frame: number;
  regions: Map<number, Region[]>;
  background: Effect | null;
  highlight: Highlight | null;
  /** outline of the selected person at a frame (source pixels) */
  focusBoxes: (frame: number) => Box[];
  onFrame: (frame: number) => void;
  /** detector/manual boxes to outline at a frame (preview-only debug overlay) */
  debugBoxes?: (frame: number) => DebugBox[];
  /** preview-only: show the raw video without mosaic */
  masksOff?: boolean;
  /** rendered over the video (e.g. the box drawing tool); receives the content rect */
  children?: (rect: Rect) => ReactNode;
}

const DEBUG_COLOR: Record<DebugKind, string> = {
  detected: '#22C55E',
  held: '#F59E0B',
  suspect: '#EF4444',
  manual: '#3B82F6',
};

function PlayerOverlayInner(props: Props) {
  const { src, videoRef, srcW, srcH, fps, frame, children } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const mediaTime = useRef(0);
  const lastFrame = useRef(-1);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });

  const draw = useCallback(() => {
    const c = canvasRef.current;
    const v = videoRef.current;
    if (!c || !v) return;
    const p = propsRef.current;
    const f = frameAt(mediaTime.current, p.fps);
    if (f !== lastFrame.current) {
      lastFrame.current = f;
      p.onFrame(f);
    }
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const r = containRect(p.srcW, p.srcH, w, h);
    if (!offRef.current) offRef.current = document.createElement('canvas');
    const src = {
      image: v,
      width: v.videoWidth,
      height: v.videoHeight,
      ready: v.readyState >= 2 && !!v.videoWidth,
    };
    drawFrameEffects(ctx, src, offRef.current, p.masksOff ? [] : (p.regions.get(f) ?? []), p.masksOff ? null : p.background, r, p.srcW, p.srcH);

    for (const fb of p.focusBoxes(f)) {
      const [dx, dy, dw, dh] = toDisplay(fb, p.srcW, p.srcH, r.w, r.h);
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#1E2A4A';
      ctx.strokeRect(r.x + dx, r.y + dy, dw, dh);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#FFFFFF';
      ctx.strokeRect(r.x + dx, r.y + dy, dw, dh);
    }
    const hl = p.highlight;
    if (hl && f >= hl.startFrame && f <= hl.endFrame) {
      const [dx, dy, dw, dh] = toDisplay(hl.box, p.srcW, p.srcH, r.w, r.h);
      ctx.fillStyle = 'rgba(245,165,36,0.14)';
      ctx.fillRect(r.x + dx, r.y + dy, dw, dh);
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#F5A524';
      ctx.strokeRect(r.x + dx, r.y + dy, dw, dh);
      ctx.setLineDash([]);
    }
    if (p.debugBoxes) {
      ctx.font = 'bold 12px sans-serif';
      ctx.textBaseline = 'middle';
      for (const b of p.debugBoxes(f)) {
        const color = DEBUG_COLOR[b.kind];
        const [dx, dy, dw, dh] = toDisplay(b.box, p.srcW, p.srcH, r.w, r.h);
        const bx = r.x + dx;
        const by = r.y + dy;
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        // dashed = no detection in this frame (held/filled), also for suspect tracks
        ctx.setLineDash(b.kind !== 'manual' && b.score === null ? [6, 4] : []);
        ctx.strokeRect(bx, by, dw, dh);
        ctx.setLineDash([]);
        const tw = ctx.measureText(b.label).width + 6;
        const th = 18;
        const ty = by - th >= r.y ? by - th : by + dh;
        ctx.fillStyle = color;
        ctx.fillRect(bx, ty, tw, th);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(b.label, bx + 3, ty + th / 2);
      }
      const tag = `f ${f} · ${debugTime(f, p.fps)}`;
      const tagW = ctx.measureText(tag).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(r.x + 6, r.y + 6, tagW, 20);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(tag, r.x + 11, r.y + 16);
    }
  }, [videoRef]);

  // keep canvas size and the letterbox rect in sync with the displayed box
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      setRect(containRect(srcW, srcH, el.clientWidth, el.clientHeight));
      draw();
    };
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [srcW, srcH, draw]);

  // frame-accurate clock: requestVideoFrameCallback, else timeupdate + rAF
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const sync = () => {
      mediaTime.current = v.currentTime;
      draw();
    };
    v.addEventListener('seeked', sync);
    v.addEventListener('loadeddata', sync);

    type VFC = (cb: (now: number, meta: { mediaTime: number }) => void) => number;
    const rvfc = (v as unknown as { requestVideoFrameCallback?: VFC }).requestVideoFrameCallback;
    let handle = 0;
    let raf = 0;
    let cancelled = false;
    if (typeof rvfc === 'function') {
      const cb = (_now: number, meta: { mediaTime: number }) => {
        if (cancelled) return;
        mediaTime.current = meta.mediaTime;
        draw();
        handle = rvfc.call(v, cb);
      };
      handle = rvfc.call(v, cb);
    } else {
      v.addEventListener('timeupdate', sync);
      const tick = () => {
        if (cancelled) return;
        if (!v.paused) sync();
        raf = window.requestAnimationFrame(tick);
      };
      if (typeof window.requestAnimationFrame === 'function') raf = window.requestAnimationFrame(tick);
    }
    return () => {
      cancelled = true;
      v.removeEventListener('seeked', sync);
      v.removeEventListener('loadeddata', sync);
      v.removeEventListener('timeupdate', sync);
      const cancel = (v as unknown as { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback;
      if (handle && cancel) cancel.call(v, handle);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [videoRef, draw]);

  // redraw when edits / highlight / seek-by-state change while paused
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.paused) mediaTime.current = frame / fps;
    draw();
  }, [props.regions, props.background, props.highlight, props.focusBoxes, props.debugBoxes, props.masksOff, frame, fps, draw, videoRef]);

  return (
    <div className="player" ref={wrapRef} data-testid="player">
      <video ref={videoRef} src={src} preload="auto" playsInline aria-label="미리보기 영상" />
      <canvas ref={canvasRef} aria-hidden="true" data-testid="overlay-canvas" />
      {children?.(rect)}
    </div>
  );
}

export const PlayerOverlay = memo(PlayerOverlayInner);
