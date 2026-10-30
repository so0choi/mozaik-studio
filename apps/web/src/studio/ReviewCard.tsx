import { memo, useState } from 'react';
import { formatTime } from '../lib/frames';
import type { ManualState, Person, ReviewItem, ReviewType } from '../lib/types';

export const TYPE_LABEL: Record<ReviewType, string> = {
  low_confidence: '낮은 신뢰도',
  gap: '추적 끊김',
  crossing: '교차 구간',
};
const TAG_CLASS: Record<ReviewType, string> = { low_confidence: 'low', gap: 'lost', crossing: 'cross' };
const EXPLAIN: Record<ReviewType, string> = {
  gap: '얼굴을 놓쳤다가 다시 찾은 구간입니다. 가림이 얼굴을 계속 덮는지 확인하세요.',
  low_confidence: '얼굴인지 확신하기 어려운 구간입니다. 가림이 필요한 얼굴이 맞는지 확인하세요.',
  crossing: '두 사람이 겹쳐 지나가는 구간입니다. 가림이 서로 바뀌지 않았는지 확인하세요.',
};

export type ReviewStage = 'ask' | 'problem' | 'split' | 'notface';

interface Option {
  label: string;
  hint: string;
}
const FACE_OPTIONS: Option[] = [
  { label: '얼굴이 보여요', hint: '보이는 얼굴 위에 박스를 그리면 앞뒤로 따라가며 가립니다' },
  { label: '얼굴이 아니에요', hint: '이 인물의 가림을 해제합니다 (음식, 손 등)' },
  { label: '가림이 얼굴보다 작아요', hint: '더 큰 박스를 덧그려 빈 곳을 덮습니다' },
];
const CROSSING_OPTIONS: Option[] = [
  { label: '두 사람이 바뀌었어요', hint: '현재 위치에서 인물을 나눕니다. 나뉜 뒤 각 조각의 가림/보임을 고르세요' },
  { label: '얼굴이 보여요', hint: '보이는 얼굴 위에 박스를 그리면 앞뒤로 따라가며 가립니다' },
  { label: '둘 중 하나가 얼굴이 아니에요', hint: '얼굴이 아닌 쪽을 보임으로 바꾸세요' },
];
export const optionCount = (type: ReviewType) => (type === 'crossing' ? CROSSING_OPTIONS.length : FACE_OPTIONS.length);

interface CardProps {
  item: ReviewItem | null;
  position: number;
  total: number;
  stage: ReviewStage;
  fps: number;
  who: string;
  manualState?: ManualState;
  splitPeople: Person[];
  onOk: () => void;
  onProblem: () => void;
  onBack: () => void;
  onOption: (n: number) => void;
  onSeek: () => void;
  onPrev: () => void;
  onNext: () => void;
  onTogglePerson: (key: string, visible: boolean) => void;
  onSplitDone: () => void;
}

function ReviewCardInner(p: CardProps) {
  const { item } = p;
  if (!item) {
    return (
      <section className="card" aria-label="검수 카드">
        <div className="empty">모든 항목 확인됨</div>
      </section>
    );
  }
  const options = item.type === 'crossing' ? CROSSING_OPTIONS : FACE_OPTIONS;
  const tracking = p.manualState === 'tracking';
  const range = `${formatTime(item.startFrame / p.fps)} - ${formatTime(item.endFrame / p.fps)}`;
  return (
    <section className="card" aria-label="검수 카드" data-testid={`review-${item.id}`}>
      <div className="chead">
        <h2>
          확인 필요 <span className="mono" style={{ color: 'var(--ink)' }}>{p.position}</span> <span>/ {p.total}</span>
        </h2>
        <button type="button" className="nav" aria-label="이전 항목" onClick={p.onPrev}>
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M9 2L4 7l5 5" />
          </svg>
        </button>
        <button type="button" className="nav" aria-label="다음 항목" onClick={p.onNext}>
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M5 2l5 5-5 5" />
          </svg>
        </button>
      </div>
      <div className="meta">
        <span className={`tag ${TAG_CLASS[item.type]}`}>{TYPE_LABEL[item.type]}</span>
        <span className="who">{p.who}</span>
        <button type="button" className="range" aria-label={`구간 ${range}로 이동`} onClick={p.onSeek}>
          {range}
        </button>
      </div>
      <p className="expl">{EXPLAIN[item.type]}</p>
      {p.manualState === 'failed' && !tracking && <div className="trk fail">추적 실패 · 구간을 직접 지정하세요</div>}

      {tracking ? (
        <div className="trk" role="status">
          <i className="spin" /> 추적 중…
        </div>
      ) : p.stage === 'split' || p.stage === 'notface' ? (
        <>
          <div className="q">{p.stage === 'split' ? '나뉜 조각' : '얼굴이 아닌 쪽을 보임으로'}</div>
          <div className="opts">
            {p.splitPeople.map((person) => (
              <div className="piece" key={person.key}>
                <span>{person.label}</span>
                <span className={`st${person.visible ? ' v' : ''}`}>{person.visible ? '보임' : '가림'}</span>
                <button
                  type="button"
                  className="sw"
                  role="switch"
                  aria-checked={person.visible}
                  aria-label={`${person.label} 보임 설정`}
                  onClick={() => p.onTogglePerson(person.key, !person.visible)}
                />
              </div>
            ))}
          </div>
          {p.stage === 'notface' && (
            <p className="expl">보임으로 바꾼 뒤 교차 구간을 재생해 얼굴이 드러나지 않는지 확인하세요</p>
          )}
          <div className="acts">
            <button type="button" className="act pri" onClick={p.onSplitDone}>
              완료 <kbd>Enter</kbd>
            </button>
          </div>
          <button type="button" className="back" onClick={p.onBack}>
            ← 뒤로 <kbd>Esc</kbd>
          </button>
        </>
      ) : p.stage === 'problem' ? (
        <>
          <div className="q">무엇이 문제인가요?</div>
          <div className="opts">
            {options.map((o, i) => (
              <button type="button" className="opt" key={o.label} onClick={() => p.onOption(i + 1)}>
                <span className="n">{i + 1}</span>
                <span>
                  <b>{o.label}</b>
                  <small>{o.hint}</small>
                </span>
              </button>
            ))}
          </div>
          <button type="button" className="back" onClick={p.onBack}>
            ← 뒤로 <kbd>Esc</kbd>
          </button>
        </>
      ) : (
        <>
          <div className="acts">
            <button type="button" className="act big ok" onClick={p.onOk}>
              괜찮음 <kbd>Enter</kbd>
            </button>
            <button type="button" className="act big bad" onClick={p.onProblem}>
              문제 있음 <kbd>X</kbd>
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export const ReviewCard = memo(ReviewCardInner);

interface UpcomingProps {
  items: ReviewItem[];
  total: number;
  done: ReviewItem[];
  hiddenCount: number;
  fps: number;
  whoOf: (item: ReviewItem) => string;
  onSelect: (id: string) => void;
}

const MAX_UPCOMING = 9;

function ReviewUpcomingInner(p: UpcomingProps) {
  const [open, setOpen] = useState(false);
  const shown = p.items.slice(0, MAX_UPCOMING);
  return (
    <section className="up-wrap" aria-label="다음 항목">
      <div className="uph">
        <span>다음 항목 · 남은 {p.total}건</span>
      </div>
      <div className="up">
        {shown.map((i) => (
          <button type="button" key={i.id} className="ur" data-testid={`review-${i.id}`} onClick={() => p.onSelect(i.id)}>
            <span className={`tg tag ${TAG_CLASS[i.type]}`}>{TYPE_LABEL[i.type]}</span>
            <span className="pn">{p.whoOf(i)}</span>
            <span className="t">{formatTime(i.startFrame / p.fps)}</span>
          </button>
        ))}
        {p.items.length > MAX_UPCOMING && <div className="more">외 {p.items.length - MAX_UPCOMING}건</div>}
        {p.items.length === 0 && <div className="more">다음 항목이 없습니다.</div>}
      </div>
      {p.hiddenCount > 0 && (
        <p className="hidden-note" data-testid="hidden-note">
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
            <span>
              {TYPE_LABEL[d.type]} · {p.whoOf(d)}
            </span>
            <span className="t">{formatTime(d.startFrame / p.fps)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export const ReviewUpcoming = memo(ReviewUpcomingInner);
