import { memo, useState } from 'react';
import { formatTime } from '../lib/frames';
import type { ManualState, ReviewItem, ReviewType } from '../lib/types';

const TYPE_LABEL: Record<ReviewType, string> = {
  low_confidence: '낮은 신뢰도',
  gap: '추적 끊김',
  crossing: '교차 구간',
};

interface Props {
  items: ReviewItem[];
  done: ReviewItem[];
  hiddenCount: number;
  activeId: string | null;
  fps: number;
  whoOf: (item: ReviewItem) => string;
  manualStateOf: (reviewId: string) => ManualState | undefined;
  onSelect: (id: string) => void;
  onOk: (id: string) => void;
  onAddBox: (id: string) => void;
}

function ReviewQueueInner(p: Props) {
  const [open, setOpen] = useState(false);
  const label = (i: ReviewItem) => `${TYPE_LABEL[i.type] ?? i.type} · ${p.whoOf(i)}`;
  return (
    <section className="panel review" aria-labelledby="rtitle">
      <div className="rhd">
        <h2 id="rtitle">
          확인 필요 <span style={{ fontSize: 15, color: 'inherit' }}>({p.items.length})</span>
        </h2>
        <span>한 건씩 확인하세요</span>
      </div>
      <div>
        {p.items.length === 0 && <div className="empty">모든 항목 확인됨</div>}
        {p.items.map((i) => {
          const st = p.manualStateOf(i.id);
          const tc = formatTime(i.startFrame / p.fps);
          return (
            <div
              key={i.id}
              className={`q${i.id === p.activeId ? ' on' : ''}`}
              data-testid={`review-${i.id}`}
              onClick={() => p.onSelect(i.id)}
            >
              <span className="lab">
                {label(i)} · <span className="t">{tc}</span>
              </span>
              {st === 'tracking' ? (
                <span className="tracking" role="status">
                  <i className="spin" /> 추적 중
                </span>
              ) : (
                <>
                  {st === 'failed' && <span className="failed">추적 실패 · 구간을 직접 지정하세요</span>}
                  <span className="acts">
                    <button
                      type="button"
                      className="ok"
                      aria-label={`${label(i)} 괜찮음`}
                      onClick={(e) => {
                        e.stopPropagation();
                        p.onOk(i.id);
                      }}
                    >
                      괜찮음
                    </button>
                    <button
                      type="button"
                      aria-label={`${label(i)} 박스 추가`}
                      onClick={(e) => {
                        e.stopPropagation();
                        p.onAddBox(i.id);
                      }}
                    >
                      박스 추가
                    </button>
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {p.hiddenCount > 0 && (
        <p className="muted" data-testid="hidden-note" style={{ margin: '8px 16px', fontSize: 13, color: 'var(--muted, #6b7280)' }}>
          지금 가림 상태로는 노출 위험이 없는 항목 {p.hiddenCount}개는 숨겼습니다
        </p>
      )}
      <button type="button" className="fold" aria-expanded={open} aria-controls="dlist" onClick={() => setOpen(!open)}>
        <span>확인 완료 ({p.done.length})</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <ul className="dl" id="dlist" hidden={!open}>
        {p.done.map((d) => (
          <li key={d.id}>
            <span>{label(d)}</span>
            <span className="t">{formatTime(d.startFrame / p.fps)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export const ReviewQueue = memo(ReviewQueueInner);
