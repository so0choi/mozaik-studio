import { memo, useEffect, useRef, useState } from 'react';
import { formatDuration } from '../lib/frames';
import type { ManualEdit, ManualState, Person } from '../lib/types';

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
  manualList: ManualEdit[];
  manualState: Record<string, ManualState>;
  manualOpen: string | null;
  onOpenManual: (id: string) => void;
}

type Filter = 'all' | 'hidden' | 'shown';

function NameInput({
  person,
  onRename,
  onDone,
}: {
  person: Person;
  onRename: (key: string, label: string) => void;
  onDone: () => void;
}) {
  const [text, setText] = useState(person.label);
  const ref = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = () => {
    const t = text.trim();
    if (!cancelled.current && t && t !== person.label) onRename(person.key, t);
    onDone();
  };
  return (
    <input
      ref={ref}
      className="nameinput"
      value={text}
      aria-label={`${person.label} 이름 편집`}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

interface RowProps {
  person: Person;
  selected: boolean;
  current: boolean;
  editing: boolean;
  suspectBadge: boolean;
  thumbSrc: (path: string) => string;
  onToggleVisible: (key: string, visible: boolean) => void;
  onToggleSelect: (key: string) => void;
  onFocusPerson: (key: string) => void;
  onRename: (key: string, label: string) => void;
  onEdit: (key: string | null) => void;
}

function Row(p: RowProps) {
  const { person } = p;
  const cls = ['pl-row', person.visible ? 'shown' : '', p.current ? 'current' : '', p.selected ? 'sel' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <li className={cls} data-testid={`card-${person.key}`} onClick={() => p.onFocusPerson(person.key)}>
      <button
        type="button"
        className="pl-ck"
        role="checkbox"
        aria-checked={p.selected}
        aria-label={`${person.label} 묶기 선택`}
        onClick={(e) => {
          e.stopPropagation();
          p.onToggleSelect(person.key);
        }}
      >
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 7.5l3 3 6-7" />
        </svg>
      </button>
      <button
        type="button"
        className="pl-thumb"
        aria-label={`${person.label} 등장 구간 보기`}
        aria-pressed={p.current}
        onClick={(e) => {
          e.stopPropagation();
          p.onFocusPerson(person.key);
        }}
      >
        <img src={p.thumbSrc(person.thumb)} alt="" />
      </button>
      <div className="pl-main">
        {p.editing ? (
          <NameInput person={person} onRename={p.onRename} onDone={() => p.onEdit(null)} />
        ) : (
          <span className="pl-name">
            <span className="pl-label" onDoubleClick={() => p.onEdit(person.key)}>
              {person.label}
            </span>
            <button
              type="button"
              className="pl-edit"
              aria-label={`${person.label} 이름 편집`}
              onClick={(e) => {
                e.stopPropagation();
                p.onEdit(person.key);
              }}
            >
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 12l1-3.5L9.5 2l2.5 2.5L5.5 11z" />
              </svg>
            </button>
          </span>
        )}
        <span className="pl-sub">
          등장 {formatDuration(person.appearSec)}
          {p.suspectBadge && <span className="badge-suspect">얼굴 아닐 수 있음</span>}
        </span>
      </div>
      <span className={`rtag${person.visible ? ' v' : ''}`}>{person.visible ? '원본' : '모자이크'}</span>
      <button
        type="button"
        className="pl-sw"
        role="switch"
        aria-checked={person.visible}
        aria-label={`${person.label} 보임 전환`}
        onClick={(e) => {
          e.stopPropagation();
          p.onToggleVisible(person.key, !person.visible);
        }}
      />
    </li>
  );
}

function TargetListInner(p: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [suspectOpen, setSuspectOpen] = useState(false);
  const [autoOpen, setAutoOpen] = useState(true);
  const [manualGroupOpen, setManualGroupOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);

  const main = p.people.filter((x) => !x.suspect);
  const suspects = p.people.filter((x) => x.suspect);
  const hiddenSuspects = suspects.filter((x) => !x.visible).length;
  const q = query.trim().toLowerCase();
  const match = (x: Person) =>
    (!q || x.label.toLowerCase().includes(q)) &&
    (filter === 'all' || (filter === 'shown' ? x.visible : !x.visible));
  const mainShown = main.filter(match);
  const suspectShown = suspects.filter(match);
  const count = p.people.length;

  const showSuspects = () => {
    if (
      window.confirm(
        `얼굴 아닐 수 있음으로 표시된 ${hiddenSuspects}개를 모두 보이게 합니다. 썸네일을 확인하셨나요?`,
      )
    )
      p.onShowSuspects();
  };

  const row = (person: Person, suspectBadge: boolean) => (
    <Row
      key={person.key}
      person={person}
      selected={p.selected.has(person.key)}
      current={p.currentKey === person.key}
      editing={editing === person.key}
      suspectBadge={suspectBadge}
      thumbSrc={p.thumbSrc}
      onToggleVisible={p.onToggleVisible}
      onToggleSelect={p.onToggleSelect}
      onFocusPerson={p.onFocusPerson}
      onRename={p.onRename}
      onEdit={setEditing}
    />
  );

  const chip = (f: Filter, label: string, n: number) => (
    <button type="button" className={`pl-chip${filter === f ? ' on' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
      {label} <em>{n}</em>
    </button>
  );

  const caret = (
    <svg className="car" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 2l5 5-5 5" />
    </svg>
  );

  return (
    <section className="tlist" aria-labelledby="tl-title">
      <div className="thead">
        <h2 id="tl-title">
          블러 대상 <em>{count}</em>
        </h2>
        {p.selected.size >= 2 && (
          <div className="pl-selbar" role="region" aria-label="선택한 인물 묶기">
            <span>{p.selected.size}개 선택됨</span>
            <button type="button" className="go" onClick={p.onMerge}>
              같은 사람으로 묶기
            </button>
            <button type="button" className="g" onClick={p.onCancelSelect}>
              해제
            </button>
          </div>
        )}
      </div>
      <div className="tfilters">
        <div className="pl-search">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5L14 14" />
          </svg>
          <input
            type="search"
            aria-label="인물 검색"
            placeholder="이름 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="pl-chips" role="group" aria-label="가림 상태 필터">
          {chip('all', '전체', count)}
          {chip('hidden', '가림', p.people.filter((x) => !x.visible).length)}
          {chip('shown', '보임', p.people.filter((x) => x.visible).length)}
        </div>
      </div>
      <div className="tgroups">
        {count === 0 ? (
          <p className="noppl">검출된 얼굴이 없습니다</p>
        ) : (
          <div className={`tgroup${autoOpen ? ' open' : ''}`}>
            <div className="tg-head">
              <button type="button" className="tg-toggle" aria-expanded={autoOpen} aria-controls="auto-body" onClick={() => setAutoOpen(!autoOpen)}>
                {caret}
                <span>자동 블러</span>
                {' '}
                <em>{main.length}</em>
              </button>
            </div>
            {autoOpen && (
              <div id="auto-body" className="tg-body">
                {main.length > 0 && mainShown.length === 0 && <p className="pl-empty">조건에 맞는 인물이 없습니다.</p>}
                {mainShown.length > 0 && <ul className="pl-rows">{mainShown.map((x) => row(x, false))}</ul>}
              </div>
            )}
          </div>
        )}
        {suspects.length > 0 && (
          <div className={`tgroup suspect${suspectOpen ? ' open' : ''}`}>
            <div className="tg-head">
              <button type="button" className="tg-toggle" aria-expanded={suspectOpen} aria-controls="suspect-body" onClick={() => setSuspectOpen(!suspectOpen)}>
                {caret}
                <span>얼굴 아닐 수 있음</span>
                {' '}
                <em>{suspects.length}</em>
              </button>
              {hiddenSuspects > 0 && (
                <button type="button" className="pl-gact" onClick={showSuspects}>
                  확인 후 모두 보임
                </button>
              )}
            </div>
            {suspectOpen && (
              <div id="suspect-body" className="tg-body">
                <p className="pl-gnote">음식, 무늬 등 얼굴이 아닌 것을 잘못 찾았을 수 있습니다. 가려진 채로 시작합니다.</p>
                {suspectShown.length === 0 ? (
                  <p className="pl-empty">조건에 맞는 인물이 없습니다.</p>
                ) : (
                  <ul className="pl-rows">{suspectShown.map((x) => row(x, true))}</ul>
                )}
              </div>
            )}
          </div>
        )}
        {p.manualList.length > 0 && (
          <div className={`tgroup manual${manualGroupOpen ? ' open' : ''}`} data-testid="manual-chip">
            <div className="tg-head">
              <button type="button" className="tg-toggle" aria-expanded={manualGroupOpen} aria-controls="manual-body" onClick={() => setManualGroupOpen(!manualGroupOpen)}>
                {caret}
                <span>직접 블러</span>
                {' '}
                <em>{p.manualList.length}</em>
              </button>
            </div>
            {manualGroupOpen && (
              <ul id="manual-body" className="tg-body mrows">
                {p.manualList.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      className={`mrow${p.manualOpen === m.id ? ' on' : ''}`}
                      aria-pressed={p.manualOpen === m.id}
                      onClick={() => p.onOpenManual(m.id)}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
                      </svg>
                      <span>수동 박스 {m.id}</span>
                      {p.manualState[m.id] === 'tracking' && (
                        <>
                          <span className="mst">추적 중</span>
                          <i className="spin" />
                        </>
                      )}
                      {p.manualState[m.id] === 'failed' && <span className="mst bad">실패</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export const TargetList = memo(TargetListInner);
