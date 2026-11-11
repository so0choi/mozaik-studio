import { memo, useEffect, useRef, useState } from 'react';
import { formatDuration, formatTime } from '../lib/frames';
import type { Effect, ManualEdit, ManualState, Person } from '../lib/types';
import { effectName } from './EffectControls';

interface Props {
  people: Person[];
  selected: Set<string>;
  currentKey: string | null;
  thumbSrc: (path: string) => string;
  /** effect actually applied to a person (shared priority logic), and whether it is the person's own setting */
  effectOf: (person: Person) => { effect: Effect; own: boolean };
  onToggleVisible: (key: string, visible: boolean) => void;
  onToggleSelect: (key: string) => void;
  onFocusPerson: (key: string) => void;
  onMerge: () => void;
  onCancelSelect: () => void;
  onRename: (key: string, label: string) => void;
  onShowSuspects: (keys: string[]) => void;
  /** move the player to a frame (used by "may not be a face" tiles) */
  onSeekFrame?: (frame: number) => void;
  /** stable getter of the player's current frame; read only on click */
  getFrame?: () => number;
  fps?: number;
  manualList: ManualEdit[];
  manualState: Record<string, ManualState>;
  manualOpen: string | null;
  onOpenManual: (id: string) => void;
  /** set only when the selection came from the video canvas; a new nonce re-triggers reveal + scroll */
  revealKey?: RevealKey | null;
}

export interface RevealKey {
  key: string;
  kind: 'person' | 'manual';
  nonce: number;
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
  tag: { effect: Effect; own: boolean };
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
      <span className={`rtag${person.visible ? ' v' : ''}`} data-testid={`rtag-${person.key}`}>
        {person.visible ? '원본' : effectName(p.tag.effect.type)}
        {!person.visible && p.tag.own && <i className="own" role="img" aria-label="개별 설정" title="개별 설정" />}
      </span>
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

interface TileProps {
  person: Person;
  current: boolean;
  /** whether the box is ticked (default: nonface only, flipped by user toggles) */
  checked: boolean;
  thumbSrc: (path: string) => string;
  onFocusPerson: (key: string) => void;
  onToggleExclude: (key: string) => void;
  onSeekFrame?: (frame: number) => void;
}

function SuspectTile(p: TileProps) {
  const { person } = p;
  const masked = !person.visible;
  const checked = masked && p.checked;
  const cls = ['stile', masked ? '' : 'shown', p.current ? 'current' : ''].filter(Boolean).join(' ');
  return (
    <li
      className={cls}
      data-testid={`card-${person.key}`}
      title="클릭하면 이 위치로 이동"
      onClick={() => {
        p.onFocusPerson(person.key);
        const first = person.segments[0]?.[0];
        if (first !== undefined) p.onSeekFrame?.(first);
      }}
    >
      <div className="st-img">
        <img src={p.thumbSrc(person.thumb)} alt="" />
        {masked && (
          <button
            type="button"
            className="pl-ck st-ck"
            role="checkbox"
            aria-checked={checked}
            aria-label={`${person.label} 가림 해제 대상`}
            onClick={(e) => {
              e.stopPropagation();
              p.onToggleExclude(person.key);
            }}
          >
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2.5 7.5l3 3 6-7" />
            </svg>
          </button>
        )}
        <span className={`st-chip${masked ? '' : ' v'}`}>{masked ? '가림' : '원본'}</span>
        {person.nonface && <span className="st-chip st-likely">가능성 높음</span>}
      </div>
      <span className="st-label">{person.label}</span>
      <span className="st-sub">{formatDuration(person.appearSec)}</span>
    </li>
  );
}

function TargetListInner(p: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [suspectOpen, setSuspectOpen] = useState(false);
  // frame the suspect list is narrowed to (null = off)
  const [sceneFrame, setSceneFrame] = useState<number | null>(null);
  const [autoOpen, setAutoOpen] = useState(true);
  const [manualGroupOpen, setManualGroupOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  // suspect tiles whose checkbox the user flipped away from its default (checked iff nonface)
  const [toggled, setToggled] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLElement>(null);
  const pending = useRef<RevealKey | null>(null);

  const main = p.people.filter((x) => !x.suspect);
  // nonface first, then larger faces first; Array.sort is stable so ties keep their order
  const suspects = p.people
    .filter((x) => x.suspect)
    .sort((a, b) => Number(b.nonface) - Number(a.nonface) || b.faceSide - a.faceSide);
  const isChecked = (x: Person) => x.nonface !== toggled.has(x.key);
  const q = query.trim().toLowerCase();
  const match = (x: Person) =>
    (!q || x.label.toLowerCase().includes(q)) &&
    (filter === 'all' || (filter === 'shown' ? x.visible : !x.visible));
  const mainShown = main.filter(match);
  const suspectShown = suspects.filter(
    (x) => match(x) && (sceneFrame === null || x.segments.some(([a, b]) => a <= sceneFrame && sceneFrame <= b)),
  );
  const count = p.people.length;
  const unmaskKeys = suspectShown.filter((x) => !x.visible && isChecked(x)).map((x) => x.key);

  // drop toggled keys that no longer exist (e.g. after a merge)
  useEffect(() => {
    setToggled((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(p.people.map((x) => x.key));
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [p.people]);
  const toggleCheck = (key: string) =>
    setToggled((prev) => {
      const n = new Set(prev);
      if (!n.delete(key)) n.add(key);
      return n;
    });

  // canvas selection: make the row renderable (reset filter/search, open its group), then scroll after render
  const reveal = p.revealKey;
  useEffect(() => {
    if (!reveal) return;
    if (reveal.kind === 'manual') {
      setManualGroupOpen(true);
    } else {
      const person = p.people.find((x) => x.key === reveal.key);
      if (!person) return;
      if (person.suspect) setSuspectOpen(true);
      else setAutoOpen(true);
      if (!match(person)) {
        setFilter('all');
        setQuery('');
      }
    }
    pending.current = reveal;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  useEffect(() => {
    const r = pending.current;
    if (!r) return;
    const id = r.kind === 'manual' ? `mrow-${r.key}` : `card-${r.key}`;
    const el = rootRef.current?.querySelector(`[data-testid="${id}"]`);
    if (!el) return;
    pending.current = null;
    el.scrollIntoView?.({ block: 'nearest' });
  });

  const showSuspects = () => {
    const keys = unmaskKeys;
    if (
      keys.length > 0 &&
      window.confirm(`얼굴 아닐 수 있음 ${keys.length}개의 가림을 해제합니다. 진짜 얼굴은 체크를 풀어 두세요.`)
    )
      p.onShowSuspects(keys);
  };

  const row = (person: Person) => (
    <Row
      key={person.key}
      person={person}
      selected={p.selected.has(person.key)}
      current={p.currentKey === person.key}
      editing={editing === person.key}
      suspectBadge={false}
      thumbSrc={p.thumbSrc}
      onToggleVisible={p.onToggleVisible}
      tag={p.effectOf(person)}
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
    <section ref={rootRef} className="tlist" aria-labelledby="tl-title">
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
                <span>자동 가림</span>
                {' '}
                <em>{main.length}</em>
              </button>
            </div>
            {autoOpen && (
              <div id="auto-body" className="tg-body">
                {main.length > 0 && mainShown.length === 0 && <p className="pl-empty">조건에 맞는 인물이 없습니다.</p>}
                {mainShown.length > 0 && <ul className="pl-rows">{mainShown.map((x) => row(x))}</ul>}
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
              {suspectOpen && unmaskKeys.length > 0 && (
                <button
                  type="button"
                  className="pl-gact"
                  title="현재 목록에 보이는(검색·필터 적용) 체크된 항목만 가림 해제합니다"
                  onClick={showSuspects}
                >
                  선택한 {unmaskKeys.length}개 가림 해제
                </button>
              )}
            </div>
            {suspectOpen && (
              <div id="suspect-body" className="tg-body">
                <p className="pl-gnote">음식, 손, 무늬 등 얼굴이 아닐 수 있는 영역입니다. 가능성이 높은 것은 분석이 끝날 때 자동으로 가림 해제했습니다. 진짜 얼굴이면 타일을 누르고 효과를 고르면 다시 가려집니다. 나머지도 얼굴이 아니면 체크해서 한 번에 가림 해제하세요.</p>
                {p.getFrame && (
                  <button
                    type="button"
                    className={`pl-chip scene${sceneFrame !== null ? ' on' : ''}`}
                    data-testid="scene-filter"
                    aria-pressed={sceneFrame !== null}
                    title="지금 화면에 박스가 있는 항목만 보여 줍니다"
                    onClick={() => setSceneFrame(sceneFrame === null ? p.getFrame!() : null)}
                  >
                    {sceneFrame === null ? '이 장면만' : `${formatTime(sceneFrame / (p.fps || 30))} 장면 ✕`}
                  </button>
                )}
                {suspectShown.length === 0 ? (
                  <p className="pl-empty">{sceneFrame !== null ? '이 장면에 해당하는 항목이 없습니다.' : '조건에 맞는 인물이 없습니다.'}</p>
                ) : (
                  <ul className="stiles">
                    {suspectShown.map((x) => (
                      <SuspectTile
                        key={x.key}
                        person={x}
                        current={p.currentKey === x.key}
                        checked={isChecked(x)}
                        thumbSrc={p.thumbSrc}
                        onFocusPerson={p.onFocusPerson}
                        onToggleExclude={toggleCheck}
                        onSeekFrame={p.onSeekFrame}
                      />
                    ))}
                  </ul>
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
                <span>직접 가림</span>
                {' '}
                <em>{p.manualList.length}</em>
              </button>
            </div>
            {manualGroupOpen && (
              <ul id="manual-body" className="tg-body mrows">
                {p.manualList.map((m) => (
                  <li key={m.id} data-testid={`mrow-${m.id}`}>
                    <button
                      type="button"
                      className={`mrow${p.manualOpen === m.id ? ' on' : ''}`}
                      aria-pressed={p.manualOpen === m.id}
                      onClick={() => p.onOpenManual(m.id)}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
                      </svg>
                      <span>수동 영역 {m.id}</span>
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
