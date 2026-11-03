import { normalizeEffects } from './effectParams';
import { effectFor } from './masks';
import { people } from './people';
import { pieces, splitFrames, visibleIds } from './pieces';
import type { Box, Edits, Effect, ManualEdit, Person, TracksDoc } from './types';

export function emptyEdits(): Edits {
  return { version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [] };
}

/** Fill missing fields so older/partial documents are safe to use. */
export function normalizeEdits(raw: Partial<Edits> | null | undefined): Edits {
  const e = raw ?? {};
  return {
    version: 1,
    visible: e.visible ?? [],
    groups: e.groups ?? [],
    splits: e.splits ?? [],
    manual: e.manual ?? [],
    reviewed: e.reviewed ?? [],
    effects: normalizeEffects(e),
  };
}

function effectsOf(edits: Edits) {
  return normalizeEffects(edits);
}

/** Set (or remove with null) the effect override of a target: track, split piece, group or manual id. */
export function setTargetEffect(edits: Edits, targetId: string, effect: Effect | null): Edits {
  const fx = effectsOf(edits);
  const overrides = { ...fx.overrides };
  if (effect) overrides[targetId] = effect;
  else delete overrides[targetId];
  return { ...edits, effects: { ...fx, overrides } };
}

export function setDefaultEffect(edits: Edits, effect: Effect): Edits {
  return { ...edits, effects: { ...effectsOf(edits), default: effect } };
}

export function setBackgroundEffect(edits: Edits, effect: Effect | null): Edits {
  return { ...edits, effects: { ...effectsOf(edits), background: effect } };
}

export function setPersonVisible(edits: Edits, person: Person, visible: boolean): Edits {
  const ids = new Set(person.trackIds);
  const rest = edits.visible.filter((v) => !ids.has(v) && v !== person.key);
  return { ...edits, visible: visible ? [...rest, ...person.trackIds] : rest };
}

/**
 * Give a person an effect in ONE edit: masked (removed from `visible`) + `overrides[person.key]`.
 * A group's member-piece overrides are cleared so the group effect really applies to every member.
 */
export function setPersonEffect(_doc: TracksDoc, edits: Edits, person: Person, effect: Effect): Edits {
  const masked = setPersonVisible(edits, person, false);
  const fx = effectsOf(masked);
  const overrides = { ...fx.overrides };
  if (person.isGroup) for (const id of person.trackIds) delete overrides[id];
  overrides[person.key] = effect;
  return { ...masked, effects: { ...fx, overrides } };
}

/** 원본 · 가림 해제. Idempotent: returns the same object when the person is already shown. */
export function uncoverPerson(_doc: TracksDoc, edits: Edits, person: Person): Edits {
  if (person.trackIds.every((id) => edits.visible.includes(id))) return edits;
  return setPersonVisible(edits, person, true);
}

/**
 * Unmask ONE piece (explicit user action). It leaves its group (a base id `tN` in the group is
 * replaced by the sibling pieces) and becomes visible; every other member keeps its visibility.
 */
export function unmaskPiece(doc: TracksDoc, edits: Edits, pieceId: string): Edits {
  const all = pieces(doc, edits);
  const piece = all.find((p) => p.id === pieceId);
  if (!piece) return edits;
  const group = edits.groups.find((g) => g.trackIds.includes(pieceId) || g.trackIds.includes(piece.trackId));
  if (!group) {
    if (visibleIds(edits).has(pieceId)) return edits;
    const person = people(doc, edits).find((p) => p.trackIds.includes(pieceId));
    return person ? setPersonVisible(edits, person, true) : edits;
  }
  const siblings = all.filter((p) => p.trackId === piece.trackId && p.id !== pieceId).map((p) => p.id);
  const members = group.trackIds
    .flatMap((id) => (id === pieceId ? [] : id === piece.trackId ? siblings : [id]))
    .filter((id, i, a) => a.indexOf(id) === i);
  // a visible group id stands for all its members: keep the others visible explicitly
  const groupShown = edits.visible.includes(group.id);
  let visible = edits.visible.filter((v) => v !== group.id);
  if (groupShown) visible = [...visible, ...members];
  if (!visible.includes(pieceId)) visible = [...visible, pieceId];
  let next: Edits = { ...edits, visible: [...new Set(visible)] };
  if (members.length < 1) {
    const fx = effectsOf(edits);
    const overrides = { ...fx.overrides };
    delete overrides[group.id];
    next = { ...next, groups: edits.groups.filter((g) => g.id !== group.id), effects: { ...fx, overrides } };
  } else {
    next = { ...next, groups: edits.groups.map((g) => (g.id === group.id ? { ...g, trackIds: members } : g)) };
  }
  return next;
}

function nextGroupId(edits: Edits): string {
  const n = edits.groups.reduce((m, g) => {
    const k = /^g(\d+)$/.exec(g.id);
    return k ? Math.max(m, Number(k[1])) : m;
  }, 0);
  return `g${n + 1}`;
}

/** Merge the persons identified by `keys` into one new group (g<n>). */
export function groupPersons(doc: TracksDoc, edits: Edits, keys: string[]): Edits {
  const selected = people(doc, edits).filter((p) => keys.includes(p.key));
  if (selected.length < 2) return edits;
  const id = nextGroupId(edits);
  const trackIds = selected.flatMap((p) => p.trackIds);
  // privacy: the merged person is shown only if every member was shown
  const allVisible = selected.every((p) => p.visible);
  const dropKeys = new Set(selected.map((p) => p.key));
  const first = selected[0];
  const keepLabel = first.isGroup ? edits.groups.find((g) => g.id === first.key)?.label : undefined;
  const ids = new Set(trackIds);
  const visible = edits.visible.filter((v) => !ids.has(v) && !dropKeys.has(v));
  const group = { id, trackIds, ...(keepLabel ? { label: keepLabel } : {}) };
  // overrides of dissolved groups go away; the first person's override moves to the new group
  const fx = effectsOf(edits);
  const overrides = { ...fx.overrides };
  const moved = overrides[first.key];
  // no member (piece or track) or dissolved-group override may survive: a piece override would outrank the group
  const allPieces = pieces(doc, edits);
  const memberIds = new Set(allPieces.filter((pc) => ids.has(pc.id)).map((pc) => pc.trackId));
  for (const k of [...dropKeys, ...ids, ...memberIds]) delete overrides[k];
  if (moved) overrides[id] = moved;
  const next: Edits = {
    ...edits,
    effects: { ...fx, overrides },
    groups: [...edits.groups.filter((g) => !dropKeys.has(g.id)), group],
    visible: allVisible ? [...visible, ...trackIds] : visible,
  };
  // a parent track's override also styled its split pieces that were NOT grouped: deleting it must not
  // change them, so copy the effect they had onto each such piece (never over its own override or group)
  for (const pc of allPieces) {
    if (ids.has(pc.id) || !memberIds.has(pc.trackId)) continue;
    const before = effectFor(pc.id, pc.trackId, edits);
    if (JSON.stringify(effectFor(pc.id, pc.trackId, next)) !== JSON.stringify(before)) {
      overrides[pc.id] = before;
    }
  }
  return next;
}

/** Set a person's name = group.label (creates a single-track group when needed). */
export function renameGroup(_doc: TracksDoc, edits: Edits, person: Person, label: string): Edits {
  const name = label.trim();
  if (person.isGroup) {
    return {
      ...edits,
      groups: edits.groups.map((g) => {
        if (g.id !== person.key) return g;
        const next = { ...g };
        if (name) next.label = name;
        else delete next.label;
        return next;
      }),
    };
  }
  if (!name) return edits;
  return {
    ...edits,
    groups: [...edits.groups, { id: nextGroupId(edits), trackIds: [...person.trackIds], label: name }],
  };
}

/** Split an unsplit track at `frame`: t2 -> t2a (< frame), t2b (>= frame). */
export function splitTrack(edits: Edits, trackId: string, frame: number): Edits {
  if (splitFrames(edits, trackId).length > 0) return edits;
  const a = `${trackId}a`;
  const b = `${trackId}b`;
  const wasVisible = edits.visible.includes(trackId);
  // a single-member group is mapped to [a] only: the split-off piece b keeps the group's effect
  const fx = effectsOf(edits);
  const solo = edits.groups.find((g) => g.trackIds.length === 1 && g.trackIds[0] === trackId);
  const effects =
    solo && Object.prototype.hasOwnProperty.call(fx.overrides, solo.id)
      ? { ...fx, overrides: { ...fx.overrides, [b]: fx.overrides[solo.id] } }
      : edits.effects;
  return {
    ...edits,
    ...(effects ? { effects } : {}),
    splits: [...edits.splits, { trackId, frame }],
    visible: wasVisible ? [...edits.visible.filter((v) => v !== trackId), a, b] : edits.visible,
    groups: edits.groups.map((g) =>
      g.trackIds.includes(trackId)
        ? {
            ...g,
            trackIds: g.trackIds.flatMap((t) =>
              t === trackId ? (g.trackIds.length === 1 ? [a] : [a, b]) : [t],
            ),
          }
        : g,
    ),
  };
}

export function markReviewed(edits: Edits, reviewId: string): Edits {
  return edits.reviewed.includes(reviewId)
    ? edits
    : { ...edits, reviewed: [...edits.reviewed, reviewId] };
}

export function addManualEdit(edits: Edits, entry: ManualEdit): Edits {
  return { ...edits, manual: [...edits.manual, entry] };
}

export function nextManualId(edits: Edits): string {
  const n = edits.manual.reduce((m, e) => {
    const k = /^m(\d+)$/.exec(e.id);
    return k ? Math.max(m, Number(k[1])) : m;
  }, 0);
  return `m${n + 1}`;
}

function mapManual(edits: Edits, manualId: string, fn: (m: ManualEdit) => ManualEdit): Edits {
  if (!edits.manual.some((m) => m.id === manualId)) return edits;
  return { ...edits, manual: edits.manual.map((m) => (m.id === manualId ? fn(m) : m)) };
}

/** Set (or clear with null) the [start, end] frame trim of a manual box. */
export function setManualTrim(edits: Edits, manualId: string, trim: [number, number] | null): Edits {
  return mapManual(edits, manualId, (m) => ({ ...m, trim }));
}

/** Soft-delete: the entry stays (so ids are never reused) but is ignored by masks and the worker. */
export function deleteManual(edits: Edits, manualId: string): Edits {
  const next = mapManual(edits, manualId, (m) => ({ ...m, deleted: true }));
  if (next === edits) return edits;
  const fx = effectsOf(edits);
  if (!(manualId in fx.overrides)) return next;
  const overrides = { ...fx.overrides };
  delete overrides[manualId];
  return { ...next, effects: { ...fx, overrides } };
}

/** Add an anchor to a manual box, replacing any anchor already at the same frame. */
export function addManualAnchor(
  edits: Edits,
  manualId: string,
  anchor: { frame: number; box: Box },
): Edits {
  return mapManual(edits, manualId, (m) => ({
    ...m,
    anchors: [...m.anchors.filter((a) => a.frame !== anchor.frame), anchor],
  }));
}
