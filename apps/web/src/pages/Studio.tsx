import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, manualDocOf, outputUrl, thumbUrl, videoUrl } from '../lib/api';
import {
  addManualAnchor,
  addManualEdit,
  deleteManual,
  emptyEdits,
  groupPersons,
  markReviewed,
  nextManualId,
  normalizeEdits,
  renameGroup,
  setManualTrim,
  setPersonVisible,
  splitTrack,
} from '../lib/edits';
import { enlargeBox } from '../lib/geometry';
import { maskBoxes } from '../lib/masks';
import { people as buildPeople } from '../lib/people';
import { pieces } from '../lib/pieces';
import type { Box, Edits, Job, ManualDoc, ManualState, ReviewItem, TracksDoc } from '../lib/types';
import { BoxTool } from '../studio/BoxTool';
import { ManualBoxCard, manualRange } from '../studio/ManualBoxCard';
import { PeopleList } from '../studio/PeopleList';
import { PlayerOverlay, type Highlight } from '../studio/PlayerOverlay';
import { requiredItems } from '../lib/reviewRequired';
import { ReviewCard, ReviewUpcoming, optionCount, type ReviewStage } from '../studio/ReviewCard';
import { Timeline } from '../studio/Timeline';
import { Header } from './Header';

const SAVE_DEBOUNCE_MS = 500;
const EDITABLE = ['ready', 'rendering', 'rendered'];

interface BoxMode {
  initial: Box | null;
  reviewId: string | null;
  /** set when redrawing an existing manual box (adds an anchor instead of a new box) */
  manualId?: string;
}

/** Keyboard events from these targets belong to the control itself. */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
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
  const [stageState, setStageState] = useState<{ id: string | null; stage: ReviewStage }>({ id: null, stage: 'ask' });
  const [manualOpen, setManualOpen] = useState<string | null>(null);
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
  // only items that can still expose a face given the current visibility edits (same rule as the API)
  const unresolved = useMemo(() => requiredItems(reviewItems, edits), [reviewItems, edits]);
  const hiddenCount = reviewItems.length - unresolved.length - reviewItems.filter((i) => reviewed.has(i.id)).length;
  const resolved = useMemo(() => reviewItems.filter((i) => reviewed.has(i.id)), [reviewItems, reviewed]);
  const current = peopleList.find((p) => p.key === currentKey) ?? null;
  const trackingCount = Object.values(manualState).filter((s) => s === 'tracking').length;
  const manualList = edits.manual.filter((m) => !m.deleted);

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

  // the focused item; falls back to the first unresolved one (e.g. after the active item was resolved elsewhere).
  // A crossing being split stays active even if the split already made it non-required.
  const activeItem = useMemo(() => {
    const inQueue = unresolved.find((i) => i.id === activeId);
    if (inQueue) return inQueue;
    if (stageState.stage === 'split' && stageState.id === activeId) {
      const it = reviewItems.find((i) => i.id === activeId);
      if (it) return it;
    }
    return unresolved[0] ?? null;
  }, [unresolved, activeId, stageState, reviewItems]);
  const stage: ReviewStage = activeItem && stageState.id === activeItem.id ? stageState.stage : 'ask';
  const setStage = useCallback(
    (st: ReviewStage) => {
      if (activeItem) setStageState({ id: activeItem.id, stage: st });
    },
    [activeItem],
  );
  const activeIndex = activeItem ? unresolved.findIndex((i) => i.id === activeItem.id) : -1;
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
      setManualOpen(null);
      if (it) seek(it.startFrame);
    },
    [reviewItems, seek],
  );
  /** Move focus to whatever follows `itemId` in the queue (call before/with the edit that removes it). */
  const advanceFrom = useCallback(
    (itemId: string) => {
      if (activeItem?.id !== itemId) return;
      const idx = unresolved.findIndex((i) => i.id === itemId);
      const rest = unresolved.filter((i) => i.id !== itemId);
      const nxt = rest[Math.max(0, Math.min(idx, rest.length - 1))];
      setActiveId(nxt?.id ?? null);
      if (nxt) seek(nxt.startFrame);
    },
    [activeItem, unresolved, seek],
  );
  const resolveItem = useCallback(
    (itemId: string) => {
      updateEdits((e) => markReviewed(e, itemId));
      advanceFrom(itemId);
    },
    [advanceFrom, updateEdits],
  );
  const stepItem = useCallback(
    (dir: 1 | -1) => {
      if (unresolved.length < 2 || !activeItem) return;
      const idx = Math.max(0, activeIndex);
      selectItem(unresolved[(idx + dir + unresolved.length) % unresolved.length].id);
    },
    [unresolved, activeItem, activeIndex, selectItem],
  );
  const addBoxFor = useCallback(
    (itemId: string, enlarge = false) => {
      const it = reviewItems.find((i) => i.id === itemId);
      if (!it || !tracks) return;
      setActiveId(itemId);
      setManualOpen(null);
      seek(it.startFrame);
      pause();
      setBoxMode({ initial: enlarge ? enlargeBox(it.box, 1.3, tracks.width, tracks.height) : it.box, reviewId: itemId });
    },
    [reviewItems, seek, tracks],
  );
  /** people that own a piece of any of these base track ids */
  const peopleOfTracks = useCallback(
    (trackIds: string[]) =>
      peopleList.filter((p) => p.trackIds.some((pid) => trackIds.includes(pieceById.get(pid)?.trackId ?? ''))),
    [peopleList, pieceById],
  );
  /** "얼굴이 아니에요": explicit user action that unmasks the person(s) owning the item's track. */
  const notAFace = useCallback(
    (item: ReviewItem) => {
      const owners = peopleOfTracks(item.trackIds.slice(0, 1));
      if (owners.length) updateEdits((e) => owners.reduce((acc, p) => setPersonVisible(acc, p, true), e));
      advanceFrom(item.id);
    },
    [peopleOfTracks, updateEdits, advanceFrom],
  );
  /** "두 사람이 바뀌었어요": split both tracks at the current frame, then let the user pick each piece. */
  const swapSplit = useCallback(
    (item: ReviewItem) => {
      if (!tracks) return;
      updateEdits((e) =>
        item.trackIds.reduce((acc, tid) => {
          const t = tracks.tracks.find((x) => x.id === tid);
          if (!t) return acc;
          const fs = Object.keys(t.frames).map(Number);
          const min = Math.min(...fs);
          const max = Math.max(...fs);
          if (min + 1 > max) return acc;
          return splitTrack(acc, tid, Math.max(min + 1, Math.min(max, frame)));
        }, e),
      );
      setStage('split');
    },
    [tracks, frame, updateEdits, setStage],
  );
  const chooseOption = useCallback(
    (n: number) => {
      if (!activeItem || stage !== 'problem' || n < 1 || n > optionCount(activeItem.type)) return;
      if (activeItem.type === 'crossing') {
        if (n === 1) swapSplit(activeItem);
        else addBoxFor(activeItem.id);
      } else if (n === 1) addBoxFor(activeItem.id);
      else if (n === 2) notAFace(activeItem);
      else addBoxFor(activeItem.id, true);
    },
    [activeItem, stage, swapSplit, addBoxFor, notAFace],
  );

  // ---- manual box ----
  const manualFirstFrame = (mid: string) => {
    const m = editsRef.current.manual.find((x) => x.id === mid);
    const doc = manualDocs[mid];
    const fs = doc ? Object.keys(doc.frames).map(Number) : [];
    const all = fs.length ? fs : (m?.anchors.map((a) => a.frame) ?? []);
    return all.length ? Math.min(...all) : 0;
  };
  const openManual = (mid: string) => {
    setManualOpen(mid);
    seek(manualFirstFrame(mid));
  };
  const manualOpenEdit = manualOpen ? edits.manual.find((m) => m.id === manualOpen && !m.deleted) ?? null : null;
  const trimFrom = () => {
    if (!manualOpenEdit) return;
    const r = manualRange(manualOpenEdit, manualDocs[manualOpenEdit.id]);
    const end = Math.max(frame, r ? r[1] : frame);
    updateEdits((e) => setManualTrim(e, manualOpenEdit.id, [frame, end]));
  };
  const trimTo = () => {
    if (!manualOpenEdit) return;
    const r = manualRange(manualOpenEdit, manualDocs[manualOpenEdit.id]);
    const start = Math.min(frame, r ? r[0] : frame);
    updateEdits((e) => setManualTrim(e, manualOpenEdit.id, [start, frame]));
  };
  const redrawManual = () => {
    if (!manualOpenEdit) return;
    const doc = manualDocs[manualOpenEdit.id];
    const box = doc?.frames[String(frame)] ?? manualOpenEdit.anchors.find((a) => a.frame === frame)?.box ?? null;
    pause();
    setBoxMode({ initial: box, reviewId: null, manualId: manualOpenEdit.id });
  };
  const removeManual = () => {
    if (!manualOpenEdit) return;
    if (!window.confirm(`수동 박스 ${manualOpenEdit.id}을 삭제할까요?`)) return;
    const mid = manualOpenEdit.id;
    updateEdits((e) => deleteManual(e, mid));
    setManualOpen(null);
    setBoxMode((b) => (b?.manualId === mid ? null : b));
  };
  const toggleBox = useCallback(() => {
    if (boxMode) setBoxMode(null);
    else {
      pause();
      setBoxMode({ initial: null, reviewId: null });
    }
  }, [boxMode]);

  const confirmBox = async (box: Box) => {
    const mode = boxMode;
    setBoxMode(null);
    const at = frame;
    if (mode?.manualId) {
      const mid = mode.manualId;
      const others = (editsRef.current.manual.find((m) => m.id === mid)?.anchors ?? [])
        .map((a) => a.frame)
        .filter((f) => f !== at);
      updateEdits((e) => addManualAnchor(e, mid, { frame: at, box }));
      setManualState((s) => ({ ...s, [mid]: 'tracking' }));
      await flush();
      try {
        await api.postManual(id, { manualId: mid, anchor: { frame: at, box }, otherAnchors: others });
      } catch (e) {
        setManualState((s) => ({ ...s, [mid]: 'failed' }));
        setNotice(e instanceof ApiError ? e.message : '추적을 요청하지 못했습니다.');
      }
      return;
    }
    const mid = nextManualId(editsRef.current);
    if (mode?.reviewId) setStageState({ id: mode.reviewId, stage: 'ask' });
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

  // ---- keyboard (one listener; always calls the latest handler) ----
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e) => {
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (boxMode) {
      if (e.key === 'Escape') {
        setBoxMode(null);
        e.preventDefault();
      }
      return;
    }
    const onControl = !!target?.closest?.('button, a, [role="switch"], [role="checkbox"], [role="slider"]');
    const itemTracking = !!activeItem && manualState[reviewManual[activeItem.id]] === 'tracking';
    const canAct = !!activeItem && !manualOpenEdit && !itemTracking;
    let handled = true;
    switch (e.key) {
      case 'Enter':
        if (onControl || !canAct) return;
        if (stage === 'ask') resolveItem(activeItem!.id);
        else if (stage === 'split') resolveItem(activeItem!.id);
        else handled = false;
        break;
      case 'x':
      case 'X':
        if (!canAct || stage !== 'ask') return;
        setStage('problem');
        break;
      case '1':
      case '2':
      case '3':
        if (!canAct || stage !== 'problem' || Number(e.key) > optionCount(activeItem!.type)) return;
        chooseOption(Number(e.key));
        break;
      case 'Escape':
        if (manualOpenEdit) setManualOpen(null);
        else if (activeItem && stage !== 'ask') setStage('ask');
        else return;
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (target?.closest?.('[role="slider"]') || unresolved.length < 2) return;
        stepItem(e.key === 'ArrowRight' ? 1 : -1);
        break;
      case 'b':
      case 'B':
        toggleBox();
        break;
      default:
        return;
    }
    if (handled) e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

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
      <main id="main" className="studio">
        <PeopleList
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
        <section className="center" aria-label="미리보기">
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
              aria-label="박스 그리기"
              aria-keyshortcuts="B"
              aria-pressed={!!boxMode}
              onClick={toggleBox}
            >
              박스 그리기 <kbd>B</kbd>
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
            <div className="legend" aria-hidden="true">
              <span>
                <i /> 확인 필요
              </span>
              <span>
                <i className="g" /> 확인 완료
              </span>
            </div>
          </div>
          {manualList.length > 0 && (
            <div className="mbrow" data-testid="manual-chip">
              <span className="mbl">수동 박스</span>
              {manualList.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={`mbchip${manualOpen === m.id ? ' on' : ''}`}
                  aria-pressed={manualOpen === m.id}
                  onClick={() => openManual(m.id)}
                >
                  수동 박스 {m.id}
                  {manualState[m.id] === 'tracking' && (
                    <>
                      {' · 추적 중 '}
                      <i className="spin" />
                    </>
                  )}
                  {manualState[m.id] === 'failed' && ' · 실패'}
                </button>
              ))}
            </div>
          )}
          <Timeline
            person={current}
            fps={fps}
            frameCount={tracks.frameCount}
            frame={frame}
            unresolved={unresolved}
            resolved={resolved}
            activeId={activeItem?.id ?? null}
            thumbSrc={thumbSrc}
            onSeek={seek}
            onSelectItem={selectItem}
          />
        </section>
        <aside className="rightcol" aria-label="검수">
          {manualOpenEdit ? (
            <ManualBoxCard
              manual={manualOpenEdit}
              doc={manualDocs[manualOpenEdit.id]}
              state={manualState[manualOpenEdit.id]}
              fps={fps}
              drawing={boxMode?.manualId === manualOpenEdit.id}
              onTrimFrom={trimFrom}
              onTrimTo={trimTo}
              onTrimClear={() => updateEdits((e) => setManualTrim(e, manualOpenEdit.id, null))}
              onRedraw={redrawManual}
              onDelete={removeManual}
              onClose={() => setManualOpen(null)}
            />
          ) : (
            <ReviewCard
              item={activeItem}
              position={Math.max(0, activeIndex) + 1}
              total={Math.max(unresolved.length, 1)}
              stage={stage}
              fps={fps}
              who={activeItem ? whoOf(activeItem) : ''}
              manualState={activeItem ? manualState[reviewManual[activeItem.id]] : undefined}
              splitPeople={activeItem ? peopleOfTracks(activeItem.trackIds) : []}
              onOk={() => activeItem && resolveItem(activeItem.id)}
              onProblem={() => setStage('problem')}
              onBack={() => setStage('ask')}
              onOption={chooseOption}
              onSeek={() => activeItem && seek(activeItem.startFrame)}
              onPrev={() => stepItem(-1)}
              onNext={() => stepItem(1)}
              onTogglePerson={toggleVisible}
              onSplitDone={() => activeItem && resolveItem(activeItem.id)}
            />
          )}
          <ReviewUpcoming
            items={unresolved.filter((i) => i.id !== activeItem?.id)}
            total={unresolved.length}
            done={resolved}
            hiddenCount={hiddenCount}
            fps={fps}
            whoOf={whoOf}
            onSelect={selectItem}
          />
          <div className="hints">
            <span><kbd>Enter</kbd>괜찮음</span>
            <span><kbd>X</kbd>문제 있음</span>
            <span><kbd>1–3</kbd>해결 방법</span>
            <span><kbd>Esc</kbd>뒤로</span>
            <span><kbd>←</kbd><kbd>→</kbd>이동</span>
            <span><kbd>B</kbd>박스 그리기</span>
          </div>
        </aside>
      </main>
      <div className="sr" aria-live="polite">
        {notice || noteText}
      </div>
    </>
  );
}
