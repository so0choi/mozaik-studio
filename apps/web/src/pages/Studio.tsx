import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, manualDocOf, outputUrl, thumbUrl, videoUrl } from '../lib/api';
import {
  addManualEdit,
  emptyEdits,
  groupPersons,
  markReviewed,
  nextManualId,
  normalizeEdits,
  renameGroup,
  setPersonVisible,
  splitTrack,
} from '../lib/edits';
import { maskBoxes } from '../lib/masks';
import { people as buildPeople } from '../lib/people';
import { pieces } from '../lib/pieces';
import type { Box, Edits, Job, ManualDoc, ManualState, ReviewItem, TracksDoc } from '../lib/types';
import { BoxTool } from '../studio/BoxTool';
import { PeopleGallery } from '../studio/PeopleGallery';
import { PlayerOverlay, type Highlight } from '../studio/PlayerOverlay';
import { ReviewQueue } from '../studio/ReviewQueue';
import { Timeline } from '../studio/Timeline';
import { Header } from './Header';

const SAVE_DEBOUNCE_MS = 500;
const EDITABLE = ['ready', 'rendering', 'rendered'];

interface BoxMode {
  initial: Box | null;
  reviewId: string | null;
}

export function Studio() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);

  const [job, setJob] = useState<Job | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tracks, setTracks] = useState<TracksDoc | null>(null);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [edits, setEdits] = useState<Edits>(emptyEdits());
  const [manualDocs, setManualDocs] = useState<Record<string, ManualDoc>>({});
  const [manualState, setManualState] = useState<Record<string, ManualState>>({});
  const [reviewManual, setReviewManual] = useState<Record<string, string>>({});
  const [frame, setFrame] = useState(0);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [boxMode, setBoxMode] = useState<BoxMode | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [renderPhase, setRenderPhase] = useState<'idle' | 'rendering'>('idle');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [outputReady, setOutputReady] = useState(false);

  // ---- edits: source of truth is the ref, saved with a 500ms debounce ----
  const editsRef = useRef<Edits>(edits);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    try {
      await api.putEdits(id, editsRef.current);
      setSaveError(null);
    } catch (e) {
      dirty.current = true;
      setSaveError(e instanceof ApiError ? e.message : '저장하지 못했습니다.');
    }
  }, [id]);

  const updateEdits = useCallback(
    (fn: (e: Edits) => Edits) => {
      const next = fn(editsRef.current);
      if (next === editsRef.current) return;
      editsRef.current = next;
      dirty.current = true;
      setEdits(next);
      setOutputReady(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void api.putEdits(id, editsRef.current).catch(() => undefined);
    },
    [id],
  );

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 401) navigate('/login');
      else setLoadError(e instanceof ApiError ? e.message : '불러오지 못했습니다.');
    },
    [navigate],
  );

  // ---- job status (poll until editable) ----
  useEffect(() => {
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api.getJob(id);
        if (stop) return;
        setJob(j);
        if (j.state === 'rendering') setRenderPhase('rendering');
        if (j.state === 'rendered' && j.hasOutput) setOutputReady(true);
        if (!EDITABLE.includes(j.state) && j.state !== 'failed') t = setTimeout(tick, 2000);
      } catch (e) {
        if (!stop) fail(e);
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [id, fail]);

  // ---- load tracks / review / edits / manual docs once the job is editable ----
  const loaded = useRef(false);
  useEffect(() => {
    if (!job || !EDITABLE.includes(job.state) || loaded.current) return;
    loaded.current = true;
    (async () => {
      try {
        const [tr, rv, ed] = await Promise.all([
          api.getTracks(id),
          api.getReview(id),
          api.getEdits(id).catch((e: unknown) => {
            if (e instanceof ApiError && e.status === 404) return null;
            throw e;
          }),
        ]);
        const norm = normalizeEdits(ed);
        editsRef.current = norm;
        setEdits(norm);
        setTracks(tr);
        setReviewItems(rv.items ?? []);
        const first = (rv.items ?? []).find((i) => !norm.reviewed.includes(i.id));
        if (first) setActiveId(first.id);
        await Promise.all(
          norm.manual
            .filter((m) => !m.deleted)
            .map(async (m) => {
              try {
                const r = await api.getManual(id, m.id);
                const doc = manualDocOf(m.id, r);
                if (doc) setManualDocs((d) => ({ ...d, [m.id]: doc }));
                setManualState((s) => ({ ...s, [m.id]: r.state }));
              } catch {
                /* no result: anchor boxes are used */
              }
            }),
        );
      } catch (e) {
        loaded.current = false;
        fail(e);
      }
    })();
  }, [job, id, fail]);

  // ---- derived data ----
  const peopleList = useMemo(() => (tracks ? buildPeople(tracks, edits) : []), [tracks, edits]);
  const pieceList = useMemo(() => (tracks ? pieces(tracks, edits) : []), [tracks, edits]);
  const pieceById = useMemo(() => new Map(pieceList.map((p) => [p.id, p])), [pieceList]);
  const masks = useMemo(
    () => (tracks ? maskBoxes(tracks, edits, Object.values(manualDocs)) : new Map()),
    [tracks, edits, manualDocs],
  );
  const reviewed = useMemo(() => new Set(edits.reviewed), [edits.reviewed]);
  const unresolved = useMemo(() => reviewItems.filter((i) => !reviewed.has(i.id)), [reviewItems, reviewed]);
  const resolved = useMemo(() => reviewItems.filter((i) => reviewed.has(i.id)), [reviewItems, reviewed]);
  const current = peopleList.find((p) => p.key === currentKey) ?? null;
  const trackingCount = Object.values(manualState).filter((s) => s === 'tracking').length;
  const failedCount = edits.manual.filter((m) => !m.deleted && manualState[m.id] === 'failed').length;
  const manualCount = edits.manual.filter((m) => !m.deleted).length;

  useEffect(() => {
    setSelected((s) => {
      const keys = new Set(peopleList.map((p) => p.key));
      const next = new Set([...s].filter((k) => keys.has(k)));
      return next.size === s.size ? s : next;
    });
    if (currentKey && peopleList.length && !peopleList.some((p) => p.key === currentKey)) setCurrentKey(null);
  }, [peopleList, currentKey]);

  const whoOf = useCallback(
    (item: ReviewItem) => {
      const labels: string[] = [];
      for (const tid of item.trackIds) {
        const p = peopleList.find((pp) => pp.trackIds.some((pid) => pieceById.get(pid)?.trackId === tid));
        if (p && !labels.includes(p.label)) labels.push(p.label);
      }
      return labels.join('·') || item.trackIds.join('·');
    },
    [peopleList, pieceById],
  );

  const focusBoxes = useCallback(
    (f: number): Box[] => {
      if (!current) return [];
      const out: Box[] = [];
      for (const pid of current.trackIds) {
        const p = pieceById.get(pid);
        if (p && f >= p.from && f <= p.to && p.track.frames[String(f)]) out.push(p.track.frames[String(f)]);
      }
      return out;
    },
    [current, pieceById],
  );

  const activeItem = unresolved.find((i) => i.id === activeId) ?? null;
  const highlight: Highlight | null = useMemo(
    () => (activeItem ? { box: activeItem.box, startFrame: activeItem.startFrame, endFrame: activeItem.endFrame } : null),
    [activeItem],
  );

  // ---- player control ----
  const fps = tracks?.fps ?? 30;
  const seek = useCallback(
    (f: number) => {
      const max = tracks ? tracks.frameCount : f;
      const clamped = Math.max(0, Math.min(max, f));
      const v = videoRef.current;
      if (v) {
        try {
          v.currentTime = clamped / fps;
        } catch {
          /* metadata not ready */
        }
      }
      setFrame(clamped);
    },
    [fps, tracks],
  );
  const pause = () => videoRef.current?.pause?.call(videoRef.current);

  // ---- gallery actions ----
  const toggleVisible = useCallback(
    (key: string, v: boolean) => {
      const person = buildPeople(tracks!, editsRef.current).find((p) => p.key === key);
      if (!person) return;
      updateEdits((e) => setPersonVisible(e, person, v));
      setCurrentKey(key);
    },
    [tracks, updateEdits],
  );
  const showSuspects = useCallback(() => {
    if (!tracks) return;
    updateEdits((e) =>
      buildPeople(tracks, e)
        .filter((p) => p.suspect && !p.visible)
        .reduce((acc, p) => setPersonVisible(acc, p, true), e),
    );
  }, [tracks, updateEdits]);
  const toggleSelect = useCallback((key: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (!n.delete(key)) n.add(key);
      return n;
    });
  }, []);
  const merge = useCallback(() => {
    const before = editsRef.current;
    const next = groupPersons(tracks!, before, [...selected]);
    if (next === before) return;
    updateEdits(() => next);
    const g = next.groups[next.groups.length - 1];
    const label = buildPeople(tracks!, next).find((p) => p.key === g.id)?.label ?? '';
    setCurrentKey(g.id);
    setSelected(new Set());
    setNotice(`${label}으로 묶였습니다`);
  }, [tracks, selected, updateEdits]);
  const clearSelect = useCallback(() => setSelected(new Set()), []);
  const rename = useCallback(
    (key: string, label: string) => {
      const person = buildPeople(tracks!, editsRef.current).find((p) => p.key === key);
      if (person) updateEdits((e) => renameGroup(tracks!, e, person, label));
    },
    [tracks, updateEdits],
  );
  const focusPerson = useCallback((key: string) => setCurrentKey(key), []);
  const thumbSrc = useCallback((path: string) => thumbUrl(id, path), [id]);

  // ---- split ----
  const splitInfo = useMemo(() => {
    if (!current || current.trackIds.length !== 1) return { ok: false, reason: '인물 1명(조각 1개)을 선택하세요' };
    const p = pieceById.get(current.trackIds[0]);
    if (!p) return { ok: false, reason: '' };
    if (p.from !== -Infinity || p.to !== Infinity) return { ok: false, reason: '이미 분할된 트랙입니다' };
    const fs = Object.keys(p.track.frames).map(Number);
    const min = Math.min(...fs);
    const max = Math.max(...fs);
    if (frame <= min || frame > max) return { ok: false, reason: '트랙 등장 구간 안에서만 분할할 수 있습니다' };
    return { ok: true, reason: '', trackId: p.trackId };
  }, [current, pieceById, frame]);

  const doSplit = () => {
    if (!splitInfo.ok || !tracks) return;
    const trackId = splitInfo.trackId!;
    const next = splitTrack(editsRef.current, trackId, frame);
    updateEdits(() => next);
    const after = buildPeople(tracks, next).find((p) => p.trackIds.includes(`${trackId}b`));
    setCurrentKey(after ? after.key : null);
    setNotice('현재 위치에서 인물을 둘로 나눴습니다');
  };

  // ---- review ----
  const selectItem = useCallback(
    (itemId: string) => {
      const it = reviewItems.find((i) => i.id === itemId);
      setActiveId(itemId);
      if (it) seek(it.startFrame);
    },
    [reviewItems, seek],
  );
  const resolveItem = useCallback(
    (itemId: string) => {
      const idx = unresolved.findIndex((i) => i.id === itemId);
      updateEdits((e) => markReviewed(e, itemId));
      if (activeId === itemId) {
        const rest = unresolved.filter((i) => i.id !== itemId);
        const nxt = rest[Math.min(idx, rest.length - 1)];
        setActiveId(nxt?.id ?? null);
        if (nxt) seek(nxt.startFrame);
      }
    },
    [unresolved, activeId, updateEdits, seek],
  );
  const addBoxFor = useCallback(
    (itemId: string) => {
      const it = reviewItems.find((i) => i.id === itemId);
      if (!it) return;
      setActiveId(itemId);
      seek(it.startFrame);
      pause();
      setBoxMode({ initial: it.box, reviewId: itemId });
    },
    [reviewItems, seek],
  );

  // ---- manual box ----
  const confirmBox = async (box: Box) => {
    const mode = boxMode;
    setBoxMode(null);
    const mid = nextManualId(editsRef.current);
    const at = frame;
    updateEdits((e) => addManualEdit(e, { id: mid, anchors: [{ frame: at, box }], trim: null, deleted: false }));
    setManualState((s) => ({ ...s, [mid]: 'tracking' }));
    if (mode?.reviewId) setReviewManual((r) => ({ ...r, [mode.reviewId!]: mid }));
    await flush();
    try {
      await api.postManual(id, { manualId: mid, anchor: { frame: at, box }, otherAnchors: [] });
    } catch (e) {
      setManualState((s) => ({ ...s, [mid]: 'failed' }));
      setNotice(e instanceof ApiError ? e.message : '추적을 요청하지 못했습니다.');
    }
  };

  const trackingKey = Object.entries(manualState)
    .filter(([, s]) => s === 'tracking')
    .map(([k]) => k)
    .sort()
    .join(',');
  const reviewManualRef = useRef(reviewManual);
  reviewManualRef.current = reviewManual;
  useEffect(() => {
    if (!trackingKey) return;
    const mids = trackingKey.split(',');
    const iv = setInterval(() => {
      mids.forEach(async (mid) => {
        try {
          const r = await api.getManual(id, mid);
          if (r.state === 'tracking') return;
          const doc = manualDocOf(mid, r);
          if (doc) setManualDocs((d) => ({ ...d, [mid]: doc }));
          setManualState((s) => (s[mid] === 'tracking' ? { ...s, [mid]: r.state } : s));
          const rid = Object.entries(reviewManualRef.current).find(([, m]) => m === mid)?.[0];
          if (rid) updateEdits((e) => markReviewed(e, rid));
        } catch {
          /* keep polling */
        }
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [trackingKey, id, updateEdits]);

  // ---- render ----
  const startRender = async () => {
    setRenderError(null);
    try {
      await flush();
      await api.render(id);
      setOutputReady(false);
      setRenderPhase('rendering');
    } catch (e) {
      setRenderError(e instanceof ApiError ? e.message : '렌더를 시작하지 못했습니다.');
    }
  };
  useEffect(() => {
    if (renderPhase !== 'rendering') return;
    const iv = setInterval(async () => {
      try {
        const j = await api.getJob(id);
        setJob(j);
        if (j.state === 'rendered' && j.hasOutput) {
          setRenderPhase('idle');
          setOutputReady(true);
        } else if (j.state === 'failed' || (j.state === 'ready' && j.error)) {
          setRenderPhase('idle');
          setRenderError(j.error ?? '렌더에 실패했습니다.');
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(iv);
  }, [renderPhase, id]);

  // ---- render ----
  if (loadError) {
    return (
      <>
        <Header />
        <main id="main" className="status-box">
          <div>
            <p>{loadError}</p>
            <p>
              <Link to="/">작업 목록으로</Link>
            </p>
          </div>
        </main>
      </>
    );
  }
  if (!job || !EDITABLE.includes(job.state) || !tracks) {
    const msg = !job
      ? '불러오는 중'
      : job.state === 'failed'
        ? (job.error ?? '처리에 실패했습니다.')
        : EDITABLE.includes(job.state)
          ? '불러오는 중'
          : job.state === 'analyzing'
            ? `분석 중 ${job.progress}%`
            : job.state === 'normalizing'
              ? '영상 변환 중'
              : '처리 대기 중';
    return (
      <>
        <Header />
        <main id="main" className="status-box">
          <div role="status">
            <p>{msg}</p>
            <p>
              <Link to="/">작업 목록으로</Link>
            </p>
          </div>
        </main>
      </>
    );
  }

  const noteText = unresolved.length
    ? `확인 필요 ${unresolved.length}건 남음`
    : trackingCount
      ? '수동 박스 추적 중'
      : '모든 항목 확인됨';
  const canRender = unresolved.length === 0 && trackingCount === 0 && renderPhase === 'idle';

  return (
    <>
      <Header>
        <div className="chipf">{job.filename}</div>
        <span className="status">
          분석 완료 · 인물 {peopleList.length}명{saveError ? ` · ${saveError}` : ''}
        </span>
        <div className="sp" />
        <span className={`note${unresolved.length || trackingCount ? '' : ' ok'}`} data-testid="note">
          {noteText}
        </span>
        <div className="render-box">
          {renderError && (
            <span className="err" role="alert">
              {renderError}
            </span>
          )}
          {outputReady && (
            <a className="btn-primary" href={outputUrl(id)} download>
              다운로드
            </a>
          )}
          <button type="button" className="btn-primary" disabled={!canRender} onClick={() => void startRender()}>
            {renderPhase === 'rendering' ? (
              <>
                <i className="spin" /> 렌더 중
              </>
            ) : outputReady ? (
              '다시 렌더'
            ) : (
              '렌더 후 다운로드'
            )}
          </button>
        </div>
      </Header>
      <main id="main">
        <PeopleGallery
          people={peopleList}
          selected={selected}
          currentKey={currentKey}
          thumbSrc={thumbSrc}
          onToggleVisible={toggleVisible}
          onToggleSelect={toggleSelect}
          onFocusPerson={focusPerson}
          onMerge={merge}
          onCancelSelect={clearSelect}
          onRename={rename}
          onShowSuspects={showSuspects}
        />
        <section className="right" aria-label="미리보기와 검수">
          <PlayerOverlay
            src={videoUrl(id)}
            videoRef={videoRef}
            srcW={tracks.width}
            srcH={tracks.height}
            fps={fps}
            frameCount={tracks.frameCount}
            frame={frame}
            boxes={masks}
            highlight={highlight}
            focusBoxes={focusBoxes}
            onFrame={setFrame}
          >
            {(rect) =>
              boxMode && (
                <BoxTool
                  rect={rect}
                  srcW={tracks.width}
                  srcH={tracks.height}
                  initial={boxMode.initial}
                  onConfirm={(b) => void confirmBox(b)}
                  onCancel={() => setBoxMode(null)}
                />
              )
            }
          </PlayerOverlay>
          <div className="tools">
            <button
              type="button"
              className="btn-ghost"
              aria-pressed={!!boxMode}
              onClick={() => {
                if (boxMode) setBoxMode(null);
                else {
                  pause();
                  setBoxMode({ initial: null, reviewId: null });
                }
              }}
            >
              박스 그리기
            </button>
            <button
              type="button"
              className="btn-ghost"
              disabled={!splitInfo.ok}
              title={splitInfo.reason || undefined}
              onClick={doSplit}
            >
              여기서 분할
            </button>
            <div className="chip" data-testid="manual-chip">
              <b>수동 박스 {manualCount}</b>
              {trackingCount > 0 && (
                <>
                  {' · 추적 중 '}
                  <i className="spin" />
                </>
              )}
            </div>
            {failedCount > 0 && <div className="chip fail">추적 실패 · 구간을 직접 지정하세요</div>}
            <div className="legend" aria-hidden="true">
              <span>
                <i /> 확인 필요
              </span>
              <span>
                <i className="g" /> 확인 완료
              </span>
            </div>
          </div>
          <Timeline
            person={current}
            fps={fps}
            frameCount={tracks.frameCount}
            frame={frame}
            unresolved={unresolved}
            resolved={resolved}
            activeId={activeId}
            thumbSrc={thumbSrc}
            onSeek={seek}
            onSelectItem={selectItem}
          />
          <ReviewQueue
            items={unresolved}
            done={resolved}
            activeId={activeId}
            fps={fps}
            whoOf={whoOf}
            manualStateOf={(rid) => manualState[reviewManual[rid]]}
            onSelect={selectItem}
            onOk={resolveItem}
            onAddBox={addBoxFor}
          />
        </section>
      </main>
      <div className="sr" aria-live="polite">
        {notice || noteText}
      </div>
    </>
  );
}
