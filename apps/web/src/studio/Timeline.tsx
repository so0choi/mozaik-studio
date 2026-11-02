import { memo, useEffect, useRef, useState } from 'react';
import { formatDuration, formatTime } from '../lib/frames';
import type { Effect, Person, Region, ReviewItem } from '../lib/types';
import { Filmstrip } from './Filmstrip';

interface Props {
  person: Person | null;
  fps: number;
  frameCount: number;
  frame: number;
  unresolved: ReviewItem[];
  resolved: ReviewItem[];
  activeId: string | null;
  /** horizontal zoom: content width = zoom * 100% of the visible area (default 1) */
  zoom?: number;
  /** filmstrip inputs; the filmstrip row is shown only when all are given */
  videoSrc?: string;
  regions?: Map<number, Region[]>;
  background?: Effect | null;
  srcW?: number;
  srcH?: number;
  /** unused since the sample thumbnails row was replaced by the filmstrip (kept for API compatibility) */
  thumbSrc?: (path: string) => string;
  onSeek: (frame: number) => void;
  onSelectItem: (id: string) => void;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MIN_TICK_PX = 70;

/** Ruler ticks as [seconds, fraction of the width]. Width 0 (unknown, e.g. jsdom) -> 6 evenly spaced labels. */
export function rulerTicks(durSec: number, widthPx: number): { t: number; at: number }[] {
  if (!(durSec > 0)) return [{ t: 0, at: 0 }];
  if (!(widthPx > 0)) return Array.from({ length: 6 }, (_, i) => ({ t: (durSec * i) / 5, at: i / 5 }));
  const pxPerSec = widthPx / durSec;
  const step = STEPS.find((s) => s * pxPerSec >= MIN_TICK_PX) ?? STEPS[STEPS.length - 1];
  const out: { t: number; at: number }[] = [];
  for (let t = 0; t <= durSec + 1e-6; t += step) out.push({ t, at: t / durSec });
  return out;
}

function TimelineInner(p: Props) {
  const zoom = Math.max(1, p.zoom ?? 1);
  const total = Math.max(1, p.frameCount);
  const pct = (f: number) => `${(Math.min(f, total) / total) * 100}%`;
  const durSec = p.frameCount / p.fps;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const contentW = viewW * zoom;
  const ticks = rulerTicks(durSec, contentW);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewW(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep the playhead in view when zoomed in
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom <= 1 || !el.clientWidth) return;
    const x = (Math.min(p.frame, total) / total) * el.scrollWidth;
    if (x < el.scrollLeft + 8 || x > el.scrollLeft + el.clientWidth - 8) el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
  }, [p.frame, total, zoom]);

  const dragging = useRef(false);
  const seekFromEvent = (e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    p.onSeek(Math.round((x / r.width) * total));
  };
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest?.('.mk')) return;
    dragging.current = true;
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* not capturable */
    }
    seekFromEvent(e);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (dragging.current) seekFromEvent(e);
  };
  const endDrag = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
  };
  const segs = p.person?.segments ?? [];
  const marker = (m: ReviewItem, resolved: boolean) => (
    <button
      key={m.id}
      type="button"
      className={`mk${resolved ? ' res' : ''}${m.id === p.activeId ? ' act' : ''}`}
      style={{ left: pct(m.startFrame) }}
      aria-label={`${resolved ? '확인 완료' : '확인 필요'} ${formatTime(m.startFrame / p.fps)}`}
      onClick={() => (resolved ? p.onSeek(m.startFrame) : p.onSelectItem(m.id))}
    />
  );
  const showFilm = !!p.videoSrc && !!p.regions && !!p.srcW && !!p.srcH;
  return (
    <section className="panel tlpanel" aria-labelledby="tlLabel">
      <div className="tl-head">
        <h2 id="tlLabel">{p.person ? `${p.person.label} 등장 구간` : '등장 구간'}</h2>
        <span id="tlInfo">
          {p.person ? `${segs.length}구간 · 총 ${formatDuration(p.person.appearSec)}` : '인물을 선택하세요'}
        </span>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div
          className="tlw"
          style={{ width: `${zoom * 100}%` }}
          data-testid="tl-content"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="ruler" aria-hidden="true">
            {ticks.map(({ t, at }, i) => (
              <span
                key={i}
                className={i === 0 ? 'first' : at > 0.97 ? 'last' : undefined}
                style={{ left: `${at * 100}%` }}
              >
                {formatTime(t)}
              </span>
            ))}
          </div>
          <div className="mkl">
            {p.unresolved.map((m) => marker(m, false))}
            {p.resolved.map((m) => marker(m, true))}
          </div>
          <div className="filmrow">
            {showFilm && (
              <Filmstrip
                src={p.videoSrc!}
                regions={p.regions!}
                background={p.background ?? null}
                srcW={p.srcW!}
                srcH={p.srcH!}
                fps={p.fps}
                frameCount={p.frameCount}
                contentWidth={contentW}
              />
            )}
            <i className="trim l" aria-hidden="true" />
            <i className="trim r" aria-hidden="true" />
          </div>
          <div
            className="track"
            role="slider"
            tabIndex={0}
            aria-label="재생 위치"
            aria-valuemin={0}
            aria-valuemax={Math.round(durSec)}
            aria-valuenow={Math.round(p.frame / p.fps)}
            aria-valuetext={formatTime(p.frame / p.fps)}
            onClick={seekFromEvent}
            onKeyDown={(e) => {
              const step = Math.round(5 * p.fps);
              if (e.key === 'ArrowRight') {
                p.onSeek(Math.min(total, p.frame + step));
                e.preventDefault();
              } else if (e.key === 'ArrowLeft') {
                p.onSeek(Math.max(0, p.frame - step));
                e.preventDefault();
              }
            }}
          >
            {segs.map(([a, b]) => (
              <div
                key={`${a}-${b}`}
                className="s"
                style={{ left: pct(a), width: `${((b - a + 1) / total) * 100}%` }}
              />
            ))}
          </div>
          <div className="ph" style={{ left: pct(p.frame) }} aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}

export const Timeline = memo(TimelineInner);
