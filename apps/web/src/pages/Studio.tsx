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
  setBackgroundEffect,
  setDefaultEffect,
  setManualTrim,
  setPersonEffect,
  setPersonVisible,
  setTargetEffect,
  uncoverPerson,
  unmaskPiece,
  splitTrack,
} from '../lib/edits';
import { enlargeBox } from '../lib/geometry';
import { emptyHistory, push as pushHistory, redo as redoHistory, undo as undoHistory, type History } from '../lib/history';
import { normalizeEffects } from '../lib/effectParams';
import { supportsCanvasFilter } from '../lib/effects';
import { effectName } from '../studio/EffectControls';
import { effectFor, maskRegions } from '../lib/masks';
import { people as buildPeople } from '../lib/people';
import { pieces } from '../lib/pieces';
import { formatDuration, timeOfFrame } from '../lib/frames';
import type { Box, Edits, Effect, Job, ManualDoc, ManualState, ReviewItem, Shape, TracksDoc } from '../lib/types';
import { BoxTool } from '../studio/BoxTool';
import { MaskPicker } from '../studio/MaskPicker';
import { ManualBoxCard, manualRange } from '../studio/ManualBoxCard';
import { LeftPanel } from '../studio/LeftPanel';
import { PlayerControls } from '../studio/PlayerControls';
import { TargetDetail } from '../studio/TargetDetail';
import { TargetList, type RevealKey } from '../studio/TargetList';
import { VideoInfo } from '../studio/VideoInfo';
import { PlayerOverlay, type Highlight } from '../studio/PlayerOverlay';
import { requiredItems } from '../lib/reviewRequired';
import { bulkConfirmable, confirmGroupEdits, groupItems, groupOf } from '../lib/reviewGroups';
import { ReviewCard, ReviewUpcoming, optionCount, type ReviewStage } from '../studio/ReviewCard';
import { Timeline } from '../studio/Timeline';
import { EmptyShell } from '../studio/EmptyShell';
import { Header } from './Header';
import { REANALYZE_BODY } from '../studio/MyJobs';

const SAVE_DEBOUNCE_MS = 500;
const EDITABLE = ['ready', 'rendering', 'rendered'];

interface BoxMode {
  shape: Shape;
  /** polygon redraw: existing vertices, kept while only the box changes */
  points?: [number, number][] | null;
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

const STALE_NOTICE = '렌더 후 편집이 바뀌었습니다. 다시 렌더하세요.';

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
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealKey | null>(null);
  const [unmaskMsg, setUnmaskMsg] = useState('');
  const unmaskTimer = useRef<ReturnType<typeof setTimeout>>();
  const [renderPhase, setRenderPhase] = useState<'idle' | 'rendering'>('idle');
  const [savingForRender, setSavingForRender] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [outputReady, setOutputReady] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [confirmReanalyze, setConfirmReanalyze] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  // bumped after a re-analysis so job polling restarts and the load effect runs again
  const [pollKey, setPollKey] = useState(0);

  // ---- edits: source of truth is the ref, saved with a 500ms debounce ----
  const editsRef = useRef<Edits>(edits);
  // every committed edit bumps saveRevision; savedRevision is the last revision the API accepted
  const saveRevision = useRef(0);
  const savedRevision = useRef(0);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  // the edits revision the last render request was made for (the download is offered only for it)
  const renderRevision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Save until the API has the latest edits. Saves are serialized (a late reply of an older save can
   * never overwrite a newer one) and an edit made during a save is saved by the same call.
   * Resolves true only when savedRevision === saveRevision.
   */
  const flush = useCallback((): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const run = async (): Promise<boolean> => {
      while (savedRevision.current !== saveRevision.current) {
        const rev = saveRevision.current;
        try {
          await api.putEdits(id, editsRef.current);
          savedRevision.current = rev;
          setSaveError(null);
        } catch (e) {
          setSaveError(e instanceof ApiError ? e.message : '저장하지 못했습니다.');
          return false;
        }
      }
      return true;
    };
    const result = saveChain.current.then(run, run);
    saveChain.current = result;
    return result;
  }, [id]);

  // shared by edits and undo/redo: ref -> state -> debounced save
  const commit = useCallback(
    (next: Edits) => {
      editsRef.current = next;
      saveRevision.current += 1;
      setEdits(next);
      setOutputReady(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // undo/redo history lives in a ref (starts empty after the initial load); the counter re-renders the buttons
  const historyRef = useRef<History>(emptyHistory());
  const [, setHistoryVersion] = useState(0);

  /** `record=false` for edits the user did not make (background tracking finishing): not an undo step. */
  const updateEdits = useCallback(
    (fn: (e: Edits) => Edits, record = true) => {
      const prev = editsRef.current;
      const next = fn(prev);
      if (next === prev) return;
      if (record) {
        historyRef.current = pushHistory(historyRef.current, prev);
        setHistoryVersion((v) => v + 1);
      }
      commit(next);
    },
    [commit],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      // the final save goes through the same serialized chain as every other save
      if (savedRevision.current !== saveRevision.current) void flush();
    },
    [id, flush],
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
        // the server decides: hasOutput is true only while output.mp4 matches the saved edits
        if (saveRevision.current === 0) {
          if (j.state === 'rendered' && j.hasOutput) setOutputReady(true);
          else if (j.outputStale && j.state !== 'rendering') setNotice(STALE_NOTICE);
        }
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
  }, [id, fail, pollKey]);

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
  const regions = useMemo(
    () => (tracks ? maskRegions(tracks, edits, Object.values(manualDocs)) : new Map()),
    [tracks, edits, manualDocs],
  );
  const background = useMemo(() => normalizeEffects(edits).background, [edits]);
  const reviewed = useMemo(() => new Set(edits.reviewed), [edits.reviewed]);
  // only items that can still expose a face given the current visibility edits (same rule as the API)
  const required = useMemo(() => requiredItems(reviewItems, edits), [reviewItems, edits]);
  const suspectIds = useMemo(() => new Set((tracks?.tracks ?? []).filter((t) => t.suspect === true).map((t) => t.id)), [tracks]);
  const isSuspect = useCallback((item: ReviewItem) => item.trackIds.length > 0 && item.trackIds.every((t) => suspectIds.has(t)), [suspectIds]);
  // 5-second windows; the queue walks them group by group (suspect-only items last inside a window)
  const groups = useMemo(() => groupItems(required, tracks?.fps ?? 30, isSuspect), [required, tracks, isSuspect]);
  const unresolved = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const advisory = useMemo(() => reviewItems.filter((i) => i.type !== 'crossing' && i.severity === 'advisory' && !reviewed.has(i.id)), [reviewItems, reviewed]);
  const hiddenCount = reviewItems.length - unresolved.length - advisory.length - reviewItems.filter((i) => reviewed.has(i.id)).length;
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
  // A crossing being split (or marked not-a-face) stays active even if the split already made it non-required.
  const activeItem = useMemo(() => {
    const inQueue = unresolved.find((i) => i.id === activeId);
    if (inQueue) return inQueue;
    if ((stageState.stage === 'split' || stageState.stage === 'notface') && stageState.id === activeId) {
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
          v.currentTime = timeOfFrame(clamped, fps);
        } catch {
          /* metadata not ready */
        }
      }
      setFrame(clamped);
    },
    [fps, tracks],
  );
  const pause = () => videoRef.current?.pause?.call(videoRef.current);
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play()?.catch?.(() => undefined);
    else v.pause();
  };
  const pickRegion = (rid: string | null) => {
    setPickedId(rid);
    if (!rid) return;
    const v = videoRef.current;
    if (v && !v.paused) v.pause();
    const person = peopleList.find((p) => p.trackIds.includes(rid));
    if (person) {
      setManualOpen(null);
      setCurrentKey(person.key);
      setReveal((r) => ({ key: person.key, kind: 'person', nonce: (r?.nonce ?? 0) + 1 }));
    } else if (editsRef.current.manual.some((m) => m.id === rid && !m.deleted)) {
      setManualOpen(rid);
      setReveal((r) => ({ key: rid, kind: 'manual', nonce: (r?.nonce ?? 0) + 1 }));
    }
  };
  const unmaskRegion = (rid: string) => {
    if (pieceById.has(rid)) updateEdits((e) => unmaskPiece(tracks!, e, rid));
    else if (editsRef.current.manual.some((m) => m.id === rid)) updateEdits((e) => deleteManual(e, rid));
    else return;
    setPickedId(null);
    setUnmaskMsg('가림을 해제했습니다 · Ctrl+Z로 되돌리기');
    clearTimeout(unmaskTimer.current);
    unmaskTimer.current = setTimeout(() => setUnmaskMsg(''), 4000);
  };
  useEffect(() => () => clearTimeout(unmaskTimer.current), []);
  const stepFrame = (delta: number) => {
    pause();
    seek(frame + delta);
  };

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
  const filterSupported = useMemo(() => supportsCanvasFilter(), []);
  const effects = useMemo(() => normalizeEffects(edits), [edits]);
  const livePerson = useCallback((key: string) => buildPeople(tracks!, editsRef.current).find((x) => x.key === key), [tracks]);
  const setEffectOf = useCallback(
    (person: { key: string }, effect: Effect) => {
      const fresh = livePerson(person.key);
      if (!fresh) return;
      updateEdits((e) => setPersonEffect(tracks!, e, fresh, effect));
      setCurrentKey(fresh.key);
    },
    [tracks, updateEdits, livePerson],
  );
  const uncover = useCallback(
    (person: { key: string }) => {
      const fresh = livePerson(person.key);
      if (fresh) updateEdits((e) => uncoverPerson(tracks!, e, fresh));
    },
    [tracks, updateEdits, livePerson],
  );
  const inheritEffect = useCallback((key: string) => updateEdits((e) => setTargetEffect(e, key, null)), [updateEdits]);
  /** effect applied to a person (same priority as the render: group, then track, then default) and whether it is the person's own */
  const effectOf = useCallback(
    (person: { key: string; trackIds: string[] }) => {
      const first = person.trackIds[0] ?? person.key;
      const trackId = pieceById.get(first)?.trackId ?? first;
      return { effect: effectFor(first, trackId, edits), own: Object.prototype.hasOwnProperty.call(effects.overrides, person.key) };
    },
    [pieceById, edits, effects],
  );
  const showSuspects = useCallback((keys: string[]) => {
    if (!tracks) return;
    const only = new Set(keys);
    updateEdits((e) =>
      buildPeople(tracks, e)
        .filter((p) => p.suspect && !p.visible && only.has(p.key))
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
  const clearFocus = useCallback(() => setCurrentKey(null), []);

  // ---- undo / redo ----
  const applyHistory = useCallback(
    (step: typeof undoHistory) => {
      const before = editsRef.current;
      const r = step(historyRef.current, before);
      if (!r) return;
      historyRef.current = r.history;
      setHistoryVersion((v) => v + 1);
      commit(r.edits);
      if (tracks) {
        const prior = new Map(buildPeople(tracks, before).map((p) => [p.key, p.visible]));
        const shown = buildPeople(tracks, r.edits).filter((p) => p.visible && !prior.get(p.key));
        if (shown.length) setNotice(`${shown.map((p) => p.label).join(', ')} 보임으로 되돌림`);
      }
    },
    [commit, tracks],
  );
  const undoEdits = useCallback(() => applyHistory(undoHistory), [applyHistory]);
  const redoEdits = useCallback(() => applyHistory(redoHistory), [applyHistory]);
  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

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
  /** Mark the active window's non-crossing items reviewed in one undo step; visibility is never touched. */
  const confirmGroup = useCallback(() => {
    if (!activeItem) return;
    const g = groupOf(groups, activeItem.id);
    if (!g) return;
    const confirmIds = new Set(g.items.filter(bulkConfirmable).map((i) => i.id));
    if (confirmIds.size === 0) return;
    const remaining = unresolved.filter((i) => !confirmIds.has(i.id));
    const gi = groups.indexOf(g);
    const nxt =
      g.items.find((i) => !confirmIds.has(i.id)) ??
      groups.slice(gi + 1).flatMap((x) => x.items)[0] ??
      remaining[0];
    updateEdits((e) => confirmGroupEdits(e, g));
    setActiveId(nxt?.id ?? null);
    setManualOpen(null);
    if (nxt) seek(nxt.startFrame);
  }, [activeItem, groups, unresolved, updateEdits, seek]);
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
      setBoxMode({ shape: 'rect', initial: enlarge ? enlargeBox(it.box, 1.3, tracks.width, tracks.height) : it.box, reviewId: itemId });
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
        else if (n === 2) addBoxFor(activeItem.id);
        else setStage('notface');
      } else if (n === 1) addBoxFor(activeItem.id);
      else if (n === 2) notAFace(activeItem);
      else addBoxFor(activeItem.id, true);
    },
    [activeItem, stage, swapSplit, addBoxFor, notAFace, setStage],
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
    setBoxMode({
      shape: manualOpenEdit.shape ?? 'rect',
      points: manualOpenEdit.points ?? null,
      initial: box,
      reviewId: null,
      manualId: manualOpenEdit.id,
    });
  };
  const removeManual = () => {
    if (!manualOpenEdit) return;
    if (!window.confirm(`수동 영역 ${manualOpenEdit.id}을 삭제할까요?`)) return;
    const mid = manualOpenEdit.id;
    updateEdits((e) => deleteManual(e, mid));
    setManualOpen(null);
    setBoxMode((b) => (b?.manualId === mid ? null : b));
  };
  /** Pick a drawing tool: same tool again closes it; another tool discards the draft and starts that shape. */
  const selectTool = useCallback(
    (shape: Shape) => {
      if (boxMode && boxMode.shape === shape && !boxMode.manualId) {
        setBoxMode(null);
        return;
      }
      pause();
      setBoxMode(boxMode && !boxMode.manualId ? { ...boxMode, shape, points: null } : { shape, initial: null, reviewId: null });
    },
    [boxMode],
  );
  const toggleBox = useCallback(() => selectTool('rect'), [selectTool]);

  const confirmBox = async (box: Box, points: [number, number][] | null) => {
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
    const shape = mode?.shape ?? 'rect';
    const mid = nextManualId(editsRef.current);
    if (mode?.reviewId) setStageState({ id: mode.reviewId, stage: 'ask' });
    updateEdits((e) => addManualEdit(e, {
        id: mid,
        anchors: [{ frame: at, box }],
        trim: null,
        deleted: false,
        ...(shape !== 'rect' ? { shape } : {}),
        ...(shape === 'polygon' && points ? { points } : {}),
      }),
    );
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
          if (rid) updateEdits((e) => markReviewed(e, rid), false);
        } catch {
          /* keep polling */
        }
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [trackingKey, id, updateEdits]);

  // ---- render ----
  const doReanalyze = async () => {
    setConfirmReanalyze(false);
    setRenderError(null);
    setReanalyzing(true);
    try {
      if (!(await flush())) {
        setRenderError('저장하지 못해 다시 분석을 시작하지 않았습니다.');
        return;
      }
      await api.reanalyze(id);
      // drop everything loaded from the old analysis; the waiting shell shows until polling reports ready
      editsRef.current = emptyEdits();
      historyRef.current = emptyHistory();
      setHistoryVersion((v) => v + 1);
      setEdits(editsRef.current);
      setTracks(null);
      setReviewItems([]);
      setManualDocs({});
      setManualState({});
      setReviewManual({});
      setFrame(0);
      setCurrentKey(null);
      setSelected(new Set());
      setActiveId(null);
      setBoxMode(null);
      setStageState({ id: null, stage: 'ask' });
      setManualOpen(null);
      setPickedId(null);
      setRenderPhase('idle');
      setOutputReady(false);
      setNotice('');
      setSaveError(null);
      setJob((j) => (j ? { ...j, state: 'queued', progress: 0, error: null, hasOutput: false, outputStale: false } : j));
      loaded.current = false;
      setPollKey((k) => k + 1);
    } catch (e) {
      setRenderError(e instanceof ApiError ? e.message : '다시 분석을 시작하지 못했습니다.');
    } finally {
      setReanalyzing(false);
    }
  };

  const startRender = async () => {
    setRenderError(null);
    setSavingForRender(true);
    try {
      // a render must never use unsaved edits: wait for the save, and do not render if it failed
      if (!(await flush())) {
        setRenderError('저장하지 못해 렌더를 시작하지 않았습니다.');
        return;
      }
      const rev = savedRevision.current; // flush() returned true: the API holds exactly this revision
      await api.render(id);
      renderRevision.current = rev;
      setOutputReady(false);
      setRenderPhase('rendering');
    } catch (e) {
      setRenderError(e instanceof ApiError ? e.message : '렌더를 시작하지 못했습니다.');
    } finally {
      setSavingForRender(false);
    }
  };
  useEffect(() => {
    if (renderPhase !== 'rendering') return;
    const iv = setInterval(async () => {
      try {
        const j = await api.getJob(id);
        setJob(j);
        if (j.state === 'rendered' && (j.hasOutput || j.outputStale)) {
          setRenderPhase('idle');
          if (j.hasOutput && saveRevision.current === renderRevision.current) {
            setOutputReady(true);
          } else {
            setOutputReady(false);
            setNotice(STALE_NOTICE);
          }
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
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !isTyping(e.target) && !boxMode) {
      const k = e.key.toLowerCase();
      if (k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoEdits();
        else undoEdits();
        return;
      }
      if (k === 'y' && e.ctrlKey) {
        e.preventDefault();
        redoEdits();
        return;
      }
    }
    if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const target = e.target as HTMLElement | null;
    if (boxMode) {
      if (e.key === 'Escape') {
        const tool = boxMode.shape;
        setBoxMode(null);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-draw-tool="${tool}"]`)?.focus());
        e.preventDefault();
      }
      return;
    }
    // effect controls own Space/arrows (they act on the focused button or slider, never on playback);
    // every other shortcut keeps working
    if ((e.key === ' ' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') && target?.closest?.('[data-effect-control]')) return;
    const onControl = !!target?.closest?.('button, a, [role="switch"], [role="checkbox"], [role="slider"]');
    const itemTracking = !!activeItem && manualState[reviewManual[activeItem.id]] === 'tracking';
    const canAct = !!activeItem && !manualOpenEdit && !itemTracking;
    let handled = true;
    switch (e.key) {
      case 'Enter':
        if (onControl || !canAct) return;
        if (e.shiftKey) {
          if (stage === 'ask') confirmGroup();
          else handled = false;
        } else if (stage === 'ask') resolveItem(activeItem!.id);
        else if (stage === 'split' || stage === 'notface') resolveItem(activeItem!.id);
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
        if (pickedId) setPickedId(null);
        else if (manualOpenEdit) setManualOpen(null);
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
      case ' ':
        // always play/pause (even on a focused button or the timeline) so a mouse-clicked
        // 괜찮음 is never pressed again by Space; preventDefault also blocks the native click
        togglePlay();
        break;
      case ',':
      case '.':
        stepFrame(e.key === '.' ? 1 : -1);
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
    const failed = job?.state === 'failed';
    const pct = job?.state === 'analyzing' ? job.progress : job?.state === 'normalizing' ? 100 : 0;
    const msg = !job
      ? '불러오는 중'
      : failed
        ? (job.error ?? '처리에 실패했습니다.')
        : EDITABLE.includes(job.state)
          ? '불러오는 중'
          : job.state === 'analyzing'
            ? `얼굴 찾는 중 ${job.progress}%`
            : job.state === 'normalizing'
              ? '영상 변환 중'
              : '대기 중';
    return (
      <EmptyShell
        center={
          <div className="up-wrap" role="status">
            <p className="up-prog-t" style={{ textAlign: 'center' }}>
              {msg}
            </p>
            {job && !failed && (
              <div className="bar-prog" role="progressbar" aria-label="처리 진행률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <i style={{ width: `${pct}%` }} />
              </div>
            )}
            {failed && (
              <p style={{ textAlign: 'center' }}>
                <Link to="/">다른 파일 올리기</Link>
              </p>
            )}
          </div>
        }
      />
    );
  }

  const activeGroup = activeItem ? groupOf(groups, activeItem.id) : null;
  const activeGroupInfo = activeGroup
    ? {
        index: groups.indexOf(activeGroup) + 1,
        total: groups.length,
        size: activeGroup.items.length,
        confirmable: activeGroup.items.filter(bulkConfirmable).length,
        startFrame: activeGroup.startFrame,
        endFrame: activeGroup.endFrame,
      }
    : undefined;
  const noteText = unresolved.length
    ? `확인 필요 ${unresolved.length}건 · ${groups.length}구간 남음`
    : trackingCount
      ? '수동 영역 추적 중'
      : '모든 항목 확인됨';
  const canRender = trackingCount === 0 && renderPhase === 'idle' && !savingForRender;

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
          <button
            type="button"
            className="btn-secondary"
            disabled={renderPhase === 'rendering' || savingForRender || reanalyzing}
            onClick={() => setConfirmReanalyze(true)}
          >
            다시 분석
          </button>
          <button type="button" className="btn-primary" disabled={!canRender} title={unresolved.length ? `확인하지 않은 ${unresolved.length}건이 있어도 렌더할 수 있습니다. 해당 구간은 자동 검출 결과대로 가려집니다.` : undefined} onClick={() => void startRender()}>
            {savingForRender ? (
              <>
                <i className="spin" /> 저장 중…
              </>
            ) : renderPhase === 'rendering' ? (
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
        <LeftPanel
          reviewCount={unresolved.length}
          drawTool={boxMode?.shape ?? null}
          onSelectTool={selectTool}
          effects={effects}
          filterSupported={filterSupported}
          onDefault={(eff) => updateEdits((e) => setDefaultEffect(e, eff))}
          onBackground={(eff) => updateEdits((e) => setBackgroundEffect(e, eff))}
          review={
            <>
              {manualOpenEdit ? (
                <p className="rv-paused">수동 영역을 편집 중입니다. 닫으면 검수를 이어갑니다.</p>
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
                  group={activeGroupInfo}
                  onConfirmGroup={confirmGroup}
                />
              )}
              <ReviewUpcoming
                groups={groups.filter((g) => g !== activeGroup)}
                totalGroups={groups.length}
                total={unresolved.length}
                isSuspect={isSuspect}
                done={resolved}
                hiddenCount={hiddenCount}
                advisory={advisory}
                onSeekItem={(id) => {
                  const it = reviewItems.find((x) => x.id === id);
                  if (it) seek(it.startFrame);
                }}
                fps={fps}
                whoOf={whoOf}
                onSelect={selectItem}
              />
            </>
          }
        />
        <section className="center" aria-label="미리보기">
          <div className="toolbar">
            <div className="tb-chips">
              {current ? (
                <span className="tchip sel">
                  <img src={thumbSrc(current.thumb)} alt="" />
                  <b>{current.label}</b>
                  <span className="mini">선택됨</span>
                </span>
              ) : (
                <span className="tchip">대상을 선택하세요</span>
              )}
              {current && (
                <>
                  <span className="tchip">
                    적용 구간 {current.segments.length}구간 · 총 {formatDuration(current.appearSec)}
                  </span>
                  <span className={`tchip fx${current.visible ? ' v' : ''}`}>
                    {current.visible ? '원본' : effectName(effectOf(current).effect.type)}
                  </span>
                </>
              )}
            </div>
            <div className="tb-acts">
              <button type="button" className="tbtn" aria-label="되돌리기" title="되돌리기 (Ctrl/⌘+Z)" disabled={!canUndo} onClick={undoEdits}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3L2.5 6.5 6 10M3 6.5h6a4 4 0 010 8H7" />
                </svg>
              </button>
              <button type="button" className="tbtn" aria-label="다시하기" title="다시하기 (Ctrl/⌘+Shift+Z)" disabled={!canRedo} onClick={redoEdits}>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 3l3.5 3.5L10 10M13 6.5H7a4 4 0 000 8h2" />
                </svg>
              </button>
              <button
                type="button"
                className="btn-primary sm"
                disabled={!splitInfo.ok}
                title={splitInfo.reason || undefined}
                onClick={doSplit}
              >
                여기서 분할
              </button>
              <div className="zoom">
                <button type="button" className="tbtn" aria-label="축소" disabled={zoom <= 1} onClick={() => setZoom((z) => Math.max(1, z - 1))}>
                  −
                </button>
                <input
                  type="range"
                  aria-label="타임라인 확대"
                  min={1}
                  max={8}
                  step={1}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
                <button type="button" className="tbtn" aria-label="확대" disabled={zoom >= 8} onClick={() => setZoom((z) => Math.min(8, z + 1))}>
                  +
                </button>
              </div>
            </div>
          </div>
          <PlayerOverlay
            src={videoUrl(id)}
            videoRef={videoRef}
            srcW={tracks.width}
            srcH={tracks.height}
            fps={fps}
            frameCount={tracks.frameCount}
            frame={frame}
            regions={regions}
            background={background}
            highlight={highlight}
            focusBoxes={focusBoxes}
            onFrame={setFrame}
          >
            {(rect) =>
              !boxMode ? (
                <MaskPicker
                  rect={rect}
                  srcW={tracks.width}
                  srcH={tracks.height}
                  regions={regions.get(frame)}
                  selectedId={pickedId}
                  onSelect={pickRegion}
                  onUnmask={unmaskRegion}
                />
              ) : (
                <BoxTool
                  key={`${boxMode.shape}:${boxMode.manualId ?? ''}`}
                  rect={rect}
                  shape={boxMode.shape}
                  initialPoints={boxMode.points ?? null}
                  srcW={tracks.width}
                  srcH={tracks.height}
                  initial={boxMode.initial}
                  onConfirm={(b, pts) => void confirmBox(b, pts)}
                  onCancel={() => setBoxMode(null)}
                />
              )
            }
          </PlayerOverlay>
          {unmaskMsg && (
            <div className="mp-status" role="status">
              {unmaskMsg}
            </div>
          )}
          <PlayerControls
            videoRef={videoRef}
            fps={fps}
            frame={frame}
            frameCount={tracks.frameCount}
            onTogglePlay={togglePlay}
            onSeek={seek}
            onStep={stepFrame}
          />
          <Timeline
            person={current}
            fps={fps}
            frameCount={tracks.frameCount}
            frame={frame}
            unresolved={unresolved}
            resolved={resolved}
            activeId={activeItem?.id ?? null}
            zoom={zoom}
            videoSrc={videoUrl(id)}
            regions={regions}
            background={background}
            srcW={tracks.width}
            srcH={tracks.height}
            onSeek={seek}
            onSelectItem={selectItem}
          />
          <div className="legend" aria-hidden="true">
            <span>
              <i /> 확인 필요
            </span>
            <span>
              <i className="g" /> 확인 완료
            </span>
          </div>
        </section>
        <aside className="rightcol" aria-label="블러 대상">
          <TargetList
            people={peopleList}
            selected={selected}
            currentKey={currentKey}
            thumbSrc={thumbSrc}
            effectOf={effectOf}
            onToggleVisible={toggleVisible}
            onToggleSelect={toggleSelect}
            onFocusPerson={focusPerson}
            onMerge={merge}
            onCancelSelect={clearSelect}
            onRename={rename}
            onShowSuspects={showSuspects}
            onSeekFrame={seek}
            manualList={manualList}
            manualState={manualState}
            manualOpen={manualOpen}
            onOpenManual={openManual}
            revealKey={reveal}
          />
          {manualOpenEdit ? (
            <ManualBoxCard
              manual={manualOpenEdit}
              doc={manualDocs[manualOpenEdit.id]}
              state={manualState[manualOpenEdit.id]}
              fps={fps}
              drawing={boxMode?.manualId === manualOpenEdit.id}
              own={effects.overrides[manualOpenEdit.id] ?? null}
              inherited={effects.default}
              filterSupported={filterSupported}
              onEffect={(eff) => updateEdits((e) => setTargetEffect(e, manualOpenEdit.id, eff))}
              onInherit={() => inheritEffect(manualOpenEdit.id)}
              onTrimFrom={trimFrom}
              onTrimTo={trimTo}
              onTrimClear={() => updateEdits((e) => setManualTrim(e, manualOpenEdit.id, null))}
              onRedraw={redrawManual}
              onDelete={removeManual}
              onClose={() => setManualOpen(null)}
            />
          ) : (
            current && (
              <TargetDetail
                person={current}
                own={effects.overrides[current.key] ?? null}
                inherited={effectOf(current).effect}
                filterSupported={filterSupported}
                onEffect={setEffectOf}
                onInherit={(person) => inheritEffect(person.key)}
                onUncover={uncover}
                onClose={clearFocus}
              />
            )
          )}
          <VideoInfo
            filename={job.filename}
            width={tracks.width}
            height={tracks.height}
            frameCount={tracks.frameCount}
            fps={fps}
          />
        </aside>
      </main>
      <div className="sr" aria-live="polite">
        {notice || noteText}
      </div>
      {confirmReanalyze && (
        <div className="dlg-scrim">
          <div className="dlg" role="dialog" aria-modal="true" aria-labelledby="reanalyze-title" aria-describedby="reanalyze-body">
            <h2 id="reanalyze-title">다시 분석할까요</h2>
            <p id="reanalyze-body">{REANALYZE_BODY}</p>
            <div className="dlg-actions">
              <button type="button" className="btn-secondary" onClick={() => setConfirmReanalyze(false)}>
                취소
              </button>
              <button type="button" className="btn-primary" autoFocus onClick={() => void doReanalyze()}>
                다시 분석
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
