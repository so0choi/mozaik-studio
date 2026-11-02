import { memo, useState, type ReactNode } from 'react';

interface Props {
  /** the review card + upcoming list (built by Studio so all handlers stay there) */
  review: ReactNode;
  /** unresolved required items, shown as a badge */
  reviewCount: number;
  /** box tool state: the 사각형 button is the existing box tool */
  boxActive: boolean;
  onToggleBox: () => void;
}

const SOON = '준비 중';

function Info() {
  return (
    <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.2v3.6M8 5v.1" />
    </svg>
  );
}

function Seg({ label, items }: { label: string; items: { name: string; on?: boolean; title?: string }[] }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((i) => (
        <button key={i.name} type="button" className={i.on ? 'on' : undefined} aria-pressed={!!i.on} disabled={!i.on} title={i.title}>
          {i.name}
        </button>
      ))}
    </div>
  );
}

function LeftPanelInner(p: Props) {
  const [hintsOpen, setHintsOpen] = useState(false);
  return (
    <aside className="left" aria-labelledby="title">
      <div className="lhead">
        <h1 id="title">대상 선택</h1>
      </div>
      <div className="lscroll">
        <section className="bcard" aria-label="검수 필요">
          <div className="bc-head">
            <h2>검수 필요</h2>
            {p.reviewCount > 0 && <span className="bdg">{p.reviewCount}</span>}
          </div>
          <div className="reviewbox">{p.review}</div>
          <button type="button" className="fold hintfold" aria-expanded={hintsOpen} aria-controls="hints" onClick={() => setHintsOpen(!hintsOpen)}>
            <span>단축키</span>
            <svg className="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
          <div className="hints" id="hints" hidden={!hintsOpen}>
            <span><kbd>Enter</kbd>괜찮음</span>
            <span><kbd>X</kbd>문제 있음</span>
            <span><kbd>1–3</kbd>해결 방법</span>
            <span><kbd>Esc</kbd>뒤로</span>
            <span><kbd>←</kbd><kbd>→</kbd>이동</span>
            <span><kbd>B</kbd>박스 그리기</span>
            <span><kbd>Space</kbd>재생/정지</span>
            <span><kbd>,</kbd><kbd>.</kbd>1프레임</span>
            <span><kbd>Ctrl/⌘+Z</kbd>되돌리기</span>
          </div>
        </section>

        <section className="bcard" aria-label="자동 블러">
          <div className="bc-head">
            <h2>
              자동 블러 <Info />
            </h2>
            <button
              type="button"
              className="tsw"
              role="switch"
              aria-checked="true"
              aria-label="자동 블러 켜짐"
              disabled
              title="얼굴 자동 가림은 끌 수 없습니다"
            />
          </div>
          <p className="sub">AI가 자동으로 찾아 가려 줍니다</p>
          <div className="pills">
            <button type="button" className="pill on" aria-pressed="true" tabIndex={-1} onClick={() => undefined}>
              사람 얼굴
            </button>
            {['사람 머리', '자동차 번호판', '사람 전체', '자동차', '텍스트'].map((n) => (
              <button key={n} type="button" className="pill" aria-pressed="false" disabled title={SOON}>
                {n}
              </button>
            ))}
          </div>
        </section>

        <section className="bcard" aria-label="직접 블러">
          <div className="bc-head">
            <h2>직접 블러</h2>
          </div>
          <p className="sub">영역을 직접 지정합니다</p>
          <div className="tools3">
            <button
              type="button"
              className="tool"
              aria-label="박스 그리기"
              aria-keyshortcuts="B"
              aria-pressed={p.boxActive}
              onClick={p.onToggleBox}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
              </svg>
              <span>사각형</span>
              <kbd>B</kbd>
            </button>
            <button type="button" className="tool" disabled title={SOON}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <ellipse cx="8" cy="8" rx="5.5" ry="4" />
              </svg>
              <span>타원</span>
            </button>
            <button type="button" className="tool" disabled title={SOON}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 2.5l5.5 4-2 6.5h-7l-2-6.5z" />
              </svg>
              <span>다각형</span>
            </button>
          </div>
        </section>

        <section className="bcard" aria-label="매직 블러">
          <div className="bc-head">
            <h2>
              매직 블러 <span className="new">NEW</span>
            </h2>
          </div>
          <p className="sub">가릴 대상을 선택하세요.</p>
          <button type="button" className="wide" disabled title={SOON}>
            대상 선택
          </button>
        </section>

        <h2 className="sect">효과</h2>
        <section className="bcard" aria-label="대상 효과">
          <div className="bc-head">
            <h2>대상 효과</h2>
          </div>
          <Seg
            label="대상 효과 종류"
            items={[
              { name: '원본', title: '인물별로 오른쪽에서 바꾸세요' },
              { name: '블러', title: SOON },
              { name: '모자이크', on: true },
              { name: '색상', title: SOON },
            ]}
          />
          <button type="button" className="rowbtn" disabled title={SOON}>
            <span>세부 조정</span>
            <span aria-hidden="true">›</span>
          </button>
        </section>
        <section className="bcard" aria-label="배경 효과">
          <div className="bc-head">
            <h2>배경 효과</h2>
          </div>
          <Seg
            label="배경 효과 종류"
            items={[
              { name: '끄기', on: true },
              { name: '블러', title: SOON },
              { name: '모자이크', title: SOON },
              { name: '색상', title: SOON },
            ]}
          />
        </section>

        <div className="lfoot">
          <button type="button" disabled title={SOON}>
            기본값으로 초기화
          </button>
          <button type="button" disabled title={SOON}>
            고급 설정
          </button>
        </div>
      </div>
    </aside>
  );
}

export const LeftPanel = memo(LeftPanelInner);
