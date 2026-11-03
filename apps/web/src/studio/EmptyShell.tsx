import { useState, type ReactNode } from 'react';
import { Header } from '../pages/Header';

const Chev = () => (
  <svg className="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6l4 4 4-4" />
  </svg>
);

/** Static, inert copy of the studio's left panel (greyed out). */
function LeftPlaceholder() {
  return (
    <aside className="left shell-off" data-testid="shell-left" aria-label="대상 선택" aria-disabled="true">
      <div className="lhead">
        <h1>대상 선택</h1>
      </div>
      <div className="lscroll">
        <section className="bcard" aria-label="자동 블러">
          <div className="bc-head">
            <h2>자동 블러</h2>
            <span className="tsw" aria-hidden="true" />
          </div>
          <p className="sub">AI가 자동으로 찾아 가려 줍니다</p>
          <div className="pills">
            <span className="pill on">사람 얼굴</span>
          </div>
        </section>
        <section className="bcard" aria-label="직접 블러">
          <div className="bc-head">
            <h2>직접 블러</h2>
          </div>
          <p className="sub">영역을 직접 지정합니다</p>
          <div className="tools3">
            {['사각형', '타원', '다각형'].map((n) => (
              <span key={n} className="tool">
                {n}
              </span>
            ))}
          </div>
        </section>
        <h2 className="sect">효과</h2>
        <section className="bcard" aria-label="효과">
          <div className="bc-head">
            <h2>기본 효과</h2>
          </div>
          <p className="sub">모자이크, 블러 등을 고를 수 있습니다</p>
        </section>
      </div>
    </aside>
  );
}

function RightPlaceholder() {
  const [open, setOpen] = useState(false);
  return (
    <aside className="rightcol shell-off" data-testid="shell-right" aria-label="블러 대상" aria-disabled="true">
      <section className="bcard" aria-label="블러 대상 목록">
        <div className="bc-head">
          <h2>블러 대상</h2>
        </div>
        <p className="sub shell-empty">블러 대상이 아직 없습니다</p>
      </section>
      <section className="bcard vinfo" aria-label="파일 정보">
        <button type="button" className="vi-toggle" aria-expanded={open} tabIndex={-1} onClick={() => setOpen(!open)}>
          <span className="h">파일 정보</span>
          <Chev />
        </button>
      </section>
    </aside>
  );
}

/** Three-column studio frame shown before a video is ready: side columns greyed, content in the centre. */
export function EmptyShell({ center, headerRight }: { center: ReactNode; headerRight?: ReactNode }) {
  return (
    <>
      <Header>{headerRight}</Header>
      <main id="main" className="studio">
        <LeftPlaceholder />
        <section className="center shell-center" aria-label="업로드">
          {center}
        </section>
        <RightPlaceholder />
      </main>
    </>
  );
}
