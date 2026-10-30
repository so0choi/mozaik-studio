import { pieceFrames, pieceSegments, pieces, visibleIds, type Piece } from './pieces';
import type { Edits, Person, TracksDoc } from './types';

function mergeSegments(segs: [number, number][]): [number, number][] {
  const sorted = [...segs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}

function defaultLabel(pieceId: string): string {
  return `인물 ${pieceId.replace(/^[A-Za-z_-]+/, '') || pieceId}`;
}

/** Piece ids a group member refers to (a base id of a split track expands to all pieces). */
function expandMember(id: string, all: Piece[]): string[] {
  const exact = all.find((p) => p.id === id);
  if (exact) return [exact.id];
  return all.filter((p) => p.trackId === id).map((p) => p.id);
}

/**
 * One Person per group, or per ungrouped (split-aware) track piece.
 * Default is hidden; a person is visible iff all its trackIds are in edits.visible.
 */
export function people(doc: TracksDoc, edits: Edits): Person[] {
  const all = pieces(doc, edits);
  const byId = new Map(all.map((p) => [p.id, p]));
  const visible = visibleIds(edits);
  const claimed = new Set<string>();
  const groupMembers = new Map<string, string[]>();

  for (const g of edits.groups) {
    const members = g.trackIds
      .flatMap((id) => expandMember(id, all))
      .filter((id, i, a) => a.indexOf(id) === i && !claimed.has(id));
    if (members.length === 0) continue;
    members.forEach((m) => claimed.add(m));
    groupMembers.set(g.id, members);
  }

  const build = (key: string, ids: string[], label: string | undefined, isGroup: boolean): Person => {
    const ps = ids.map((id) => byId.get(id)!);
    const frames = ps.reduce((n, p) => n + pieceFrames(p).length, 0);
    const segs = ps.flatMap(pieceSegments);
    return {
      key,
      label: label?.trim() || (ps[0] ? defaultLabel(ps[0].id) : key),
      trackIds: ids,
      visible: ids.every((id) => visible.has(id)),
      thumb: ps[0].track.thumb,
      samples: [...new Set(ps.flatMap((p) => p.track.samples))],
      fragmentCount: segs.length,
      appearSec: frames / doc.fps,
      segments: mergeSegments(segs),
      isGroup,
      suspect: ps.every((p) => p.track.suspect === true),
    };
  };

  const out: Person[] = [];
  const emitted = new Set<string>();
  for (const p of all) {
    if (claimed.has(p.id)) {
      for (const g of edits.groups) {
        const members = groupMembers.get(g.id);
        if (!members || !members.includes(p.id) || emitted.has(g.id)) continue;
        emitted.add(g.id);
        out.push(build(g.id, members, g.label, true));
      }
      continue;
    }
    out.push(build(p.id, [p.id], undefined, false));
  }
  // non-suspect first, suspects last; stable within each part
  return [...out.filter((p) => !p.suspect), ...out.filter((p) => p.suspect)];
}
