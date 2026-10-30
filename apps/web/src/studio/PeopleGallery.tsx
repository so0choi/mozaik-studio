import { memo, useEffect, useState } from 'react';
import { formatDuration } from '../lib/frames';
import type { Person } from '../lib/types';

interface Props {
  people: Person[];
  selected: Set<string>;
  currentKey: string | null;
  thumbSrc: (path: string) => string;
  onToggleVisible: (key: string, visible: boolean) => void;
  onToggleSelect: (key: string) => void;
  onFocusPerson: (key: string) => void;
  onMerge: () => void;
  onCancelSelect: () => void;
  onRename: (key: string, label: string) => void;
  onShowSuspects: () => void;
}

function NameInput({ person, onRename }: { person: Person; onRename: (key: string, label: string) => void }) {
  const [text, setText] = useState(person.label);
  useEffect(() => setText(person.label), [person.label]);
  const commit = () => {
    const t = text.trim();
    if (!t) {
      setText(person.label);
      return;
    }
    if (t !== person.label) onRename(person.key, t);
  };
  return (
    <input
      className="nameinput"
      value={text}
      aria-label={`${person.label} 이름 편집`}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(person.label);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function PeopleGalleryInner(p: Props) {
  const count = p.people.length;
  const hiddenSuspects = p.people.filter((x) => x.suspect && !x.visible).length;
  const showSuspects = () => {
    if (
      window.confirm(
        `얼굴 아닐 수 있음으로 표시된 ${hiddenSuspects}개를 모두 보이게 합니다. 썸네일을 확인하셨나요?`,
      )
    )
      p.onShowSuspects();
  };
  return (
    <section className="left" aria-labelledby="title">
      <div className="lhead">
        <h1 id="title">{count ? `등장인물 ${count}명` : '등장인물'}</h1>
        <p className="hint">기본은 모두 가림 · 보일 사람만 켜세요</p>
      </div>
      <div className="gridwrap">
        {hiddenSuspects > 0 && (
          <div className="suspectbar">
            <span>얼굴이 아닐 수 있는 항목 {hiddenSuspects}개</span>
            <button type="button" onClick={showSuspects}>
              확인 후 모두 보임
            </button>
          </div>
        )}
        {count === 0 ? (
          <p className="noppl">검출된 얼굴이 없습니다</p>
        ) : (
          <ul className="grid">
            {p.people.map((person) => {
              const sel = p.selected.has(person.key);
              const cur = p.currentKey === person.key;
              const cls = ['card', person.visible ? 'shown' : '', cur ? 'current' : '', sel ? 'sel' : '']
                .filter(Boolean)
                .join(' ');
              return (
                <li key={person.key} className={cls} data-testid={`card-${person.key}`}>
                  <button
                    type="button"
                    className="chk"
                    role="checkbox"
                    aria-checked={sel}
                    aria-label={`${person.label} 묶기 선택`}
                    onClick={() => p.onToggleSelect(person.key)}
                  >
                    <span>
                      <svg viewBox="0 0 14 14" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2.5 7.5l3 3 6-7" />
                      </svg>
                    </span>
                  </button>
                  {person.visible && <span className="badge">보임</span>}
                  {person.suspect && <span className="badge-suspect">얼굴 아닐 수 있음</span>}
                  <button
                    type="button"
                    className="avatar"
                    aria-label={`${person.label} 등장 구간 보기`}
                    aria-pressed={cur}
                    onClick={() => p.onFocusPerson(person.key)}
                  >
                    <img src={p.thumbSrc(person.thumb)} alt="" />
                  </button>
                  <NameInput person={person} onRename={p.onRename} />
                  <span className="sub">등장 {formatDuration(person.appearSec)}</span>
                  <div className="frags">
                    {person.samples.slice(0, 3).map((s) => (
                      <span className="t" key={s}>
                        <img src={p.thumbSrc(s)} alt="" />
                      </span>
                    ))}
                    <span>조각 {person.fragmentCount}개</span>
                  </div>
                  <div className="seg" role="group" aria-label={`${person.label} 가림 또는 보임`}>
                    <button
                      type="button"
                      className="hide"
                      aria-pressed={!person.visible}
                      onClick={() => p.onToggleVisible(person.key, false)}
                    >
                      가림
                    </button>
                    <button
                      type="button"
                      className="show"
                      aria-pressed={person.visible}
                      onClick={() => p.onToggleVisible(person.key, true)}
                    >
                      보임
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {p.selected.size >= 2 && (
          <div className="bar on" role="region" aria-label="선택한 인물 묶기">
            <span>
              <b>{p.selected.size}개 선택됨</b>
            </span>
            <button type="button" className="go" onClick={p.onMerge}>
              같은 사람으로 묶기
            </button>
            <button type="button" className="cancel" onClick={p.onCancelSelect}>
              취소
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export const PeopleGallery = memo(PeopleGalleryInner);
