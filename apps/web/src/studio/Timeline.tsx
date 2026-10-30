import { memo, useRef } from 'react';
import { formatDuration, formatTime } from '../lib/frames';
import type { Person, ReviewItem } from '../lib/types';

interface Props {
  person: Person | null;
  fps: number;
  frameCount: number;
  frame: number;
  unresolved: ReviewItem[];
  resolved: ReviewItem[];
  activeId: string | null;
  thumbSrc: (path: string) => string;
  onSeek: (frame: number) => void;
  onSelectItem: (id: string) => void;
}

function TimelineInner(p: Props) {
  const total = Math.max(1, p.frameCount);
  const pct = (f: number) => `${(Math.min(f, total) / total) * 100}%`;
  const durSec = p.frameCount / p.fps;
  const ticks = Array.from({ length: 6 }, (_, i) => formatTime((durSec * i) / 5));
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
  return (
    <section className="panel" aria-labelledby="tlLabel">
      <div className="tl-head">
        <h2 id="tlLabel">{p.person ? `${p.person.label} 등장 구간` : '등장 구간'}</h2>
        <span id="tlInfo">
          {p.person ? `${segs.length}구간 · 총 ${formatDuration(p.person.appearSec)}` : '인물을 선택하세요'}
        </span>
      </div>
      <div
        className="tlw"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="mkl">
          {p.unresolved.map((m) => marker(m, false))}
          {p.resolved.map((m) => marker(m, true))}
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
        <div className="ph" style={{ left: pct(p.frame) }} />
      </div>
      <div className="ticks" aria-hidden="true">
        {ticks.map((t, i) => (
          <span key={i}>{t}</span>
        ))}
      </div>
      {p.person && p.person.samples.length > 0 && (
        <div className="samples">
          {p.person.samples.map((s) => (
            <img key={s} src={p.thumbSrc(s)} alt="" />
          ))}
        </div>
      )}
    </section>
  );
}

export const Timeline = memo(TimelineInner);
