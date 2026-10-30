import { people } from './people';
import { splitFrames } from './pieces';
import type { Edits, ManualEdit, Person, TracksDoc } from './types';

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
  };
}

export function setPersonVisible(edits: Edits, person: Person, visible: boolean): Edits {
  const ids = new Set(person.trackIds);
  const rest = edits.visible.filter((v) => !ids.has(v) && v !== person.key);
  return { ...edits, visible: visible ? [...rest, ...person.trackIds] : rest };
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
  return {
    ...edits,
    groups: [...edits.groups.filter((g) => !dropKeys.has(g.id)), group],
    visible: allVisible ? [...visible, ...trackIds] : visible,
  };
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
  return {
    ...edits,
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
