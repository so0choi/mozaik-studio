import { memo } from 'react';
import { formatTime } from '../lib/frames';
import type { ManualDoc, ManualEdit, ManualState } from '../lib/types';

/** Frame range a manual box covers: trim, else tracked segments, else anchor frames. */
export function manualRange(m: ManualEdit, doc?: ManualDoc): [number, number] | null {
  if (m.trim) return m.trim;
  if (doc && doc.segments.length) {
    return [Math.min(...doc.segments.map((s) => s[0])), Math.max(...doc.segments.map((s) => s[1]))];
  }
  const fs = doc ? Object.keys(doc.frames).map(Number) : [];
  const all = fs.length ? fs : m.anchors.map((a) => a.frame);
  return all.length ? [Math.min(...all), Math.max(...all)] : null;
}

interface Props {
  manual: ManualEdit;
  doc?: ManualDoc;
  state?: ManualState;
  fps: number;
  drawing: boolean;
  onTrimFrom: () => void;
  onTrimTo: () => void;
  onTrimClear: () => void;
  onRedraw: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function ManualBoxCardInner(p: Props) {
  const range = manualRange(p.manual, p.doc);
  const tracking = p.state === 'tracking';
  return (
    <section className="card" aria-label="수동 박스" data-testid={`manual-card-${p.manual.id}`}>
      <div className="chead">
        <h2>
          수동 박스 <span className="mono" style={{ color: 'var(--ink)' }}>{p.manual.id}</span>
        </h2>
      </div>
      <div className="meta">
        <span className="tag lost">수동 박스</span>
        <span className="range" data-testid="manual-range">
          {range ? `${formatTime(range[0] / p.fps)} - ${formatTime(range[1] / p.fps)} (${range[0]}-${range[1]}f)` : '-'}
        </span>
      </div>
      {tracking && (
        <div className="trk" role="status">
          <i className="spin" /> 추적 중…
        </div>
      )}
      {p.state === 'failed' && <div className="trk fail">추적 실패 · 구간을 직접 지정하세요</div>}
      {p.drawing && (
        <div className="trk">
          <i className="spin" /> 플레이어에서 다시 그릴 영역을 드래그하세요
        </div>
      )}
      <div className="cut">
        <div className="q">구간 자르기</div>
        <div className="acts">
          <button type="button" className="act" onClick={p.onTrimFrom}>
            여기부터
          </button>
          <button type="button" className="act" onClick={p.onTrimTo}>
            여기까지
          </button>
        </div>
        {p.manual.trim && (
          <button type="button" className="back ul" onClick={p.onTrimClear}>
            자르기 해제
          </button>
        )}
      </div>
      <div className="opts">
        <button type="button" className="opt" onClick={p.onRedraw} disabled={tracking}>
          <span className="n">↻</span>
          <span>
            <b>다시 그리기</b>
            <small>그린 프레임부터 다음 기준점까지만 다시 추적합니다</small>
          </span>
        </button>
        <button type="button" className="opt danger" onClick={p.onDelete}>
          <span className="n">✕</span>
          <span>
            <b>삭제</b>
            <small>이 수동 박스를 지웁니다</small>
          </span>
        </button>
      </div>
      <button type="button" className="back ul" onClick={p.onClose}>
        닫기 <kbd>Esc</kbd>
      </button>
    </section>
  );
}

export const ManualBoxCard = memo(ManualBoxCardInner);
