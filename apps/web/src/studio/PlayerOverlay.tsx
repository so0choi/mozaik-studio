import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { formatTime, frameAt } from '../lib/frames';
import { containRect, toDisplay, type Rect } from '../lib/geometry';
import type { Box, MaskBox } from '../lib/types';

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
  boxes: Map<number, MaskBox[]>;
  highlight: Highlight | null;
  /** outline of the selected person at a frame (source pixels) */
  focusBoxes: (frame: number) => Box[];
  onFrame: (frame: number) => void;
  /** rendered over the video (e.g. the box drawing tool); receives the content rect */
  children?: (rect: Rect) => ReactNode;
}

function pixelate(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  off: HTMLCanvasElement,
  b: MaskBox,
  rect: Rect,
  srcW: number,
  srcH: number,
) {
  const [x, y, w, h, block] = b;
  const [dx, dy, dw, dh] = toDisplay([x, y, w, h], srcW, srcH, rect.w, rect.h);
  const ox = rect.x + dx;
  const oy = rect.y + dy;
  const octx = off.getContext('2d');
  if (!octx || video.readyState < 2 || !video.videoWidth) {
    // frame not decodable yet: never show the raw area
    ctx.fillStyle = '#6b6f7a';
    ctx.fillRect(ox, oy, dw, dh);
    return;
  }
  // block grid origin = box top-left in SOURCE pixels, block size in source pixels
  const cols = Math.max(1, Math.ceil(w / block));
  const rows = Math.max(1, Math.ceil(h / block));
  off.width = cols;
  off.height = rows;
  const vx = video.videoWidth / srcW;
  const vy = video.videoHeight / srcH;
  try {
    octx.drawImage(video, x * vx, y * vy, cols * block * vx, rows * block * vy, 0, 0, cols, rows);
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
    ctx.fillStyle = '#6b6f7a';
    ctx.fillRect(ox, oy, dw, dh);
  }
}

function PlayerOverlayInner(props: Props) {
  const { src, videoRef, srcW, srcH, fps, frameCount, frame, children } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const offRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const mediaTime = useRef(0);
  const lastFrame = useRef(-1);
  const [playing, setPlaying] = useState(false);
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
    for (const b of p.boxes.get(f) ?? []) pixelate(ctx, v, offRef.current, b, r, p.srcW, p.srcH);

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
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('seeked', sync);
    v.addEventListener('loadeddata', sync);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onPause);

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
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onPause);
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
  }, [props.boxes, props.highlight, props.focusBoxes, frame, fps, draw, videoRef]);

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play()?.catch?.(() => undefined);
    else v.pause();
  };
  const back = () => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.max(0, v.currentTime - 5);
  };

  return (
    <div className="player" ref={wrapRef} data-testid="player">
      <video ref={videoRef} src={src} preload="auto" playsInline aria-label="미리보기 영상" />
      <canvas ref={canvasRef} aria-hidden="true" data-testid="overlay-canvas" />
      {children?.(rect)}
      <div className="pctl">
        <button type="button" className="play" onClick={toggle} aria-label={playing ? '일시정지' : '재생'}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {playing ? <path d="M3.5 2h3v12h-3zM9.5 2h3v12h-3z" /> : <path d="M4 2.5v11l9-5.5z" />}
          </svg>
        </button>
        <button type="button" className="ic" onClick={back} aria-label="5초 뒤로">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v3L3.5 3.5 8 1v2a6 6 0 11-6 6h1.6A4.4 4.4 0 108 3z" transform="translate(0 1)" />
          </svg>
        </button>
        <div className="time" data-testid="time">
          {formatTime(frame / fps)} <span>/ {formatTime(frameCount / fps)}</span>
        </div>
      </div>
    </div>
  );
}

export const PlayerOverlay = memo(PlayerOverlayInner);
