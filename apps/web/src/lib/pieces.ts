import type { Edits, Track, TracksDoc } from './types';

/** A track, or one fragment of a split track. */
export interface Piece {
  id: string;
  trackId: string;
  track: Track;
  /** inclusive frame range this piece covers */
  from: number;
  to: number;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Split frames for a track, ascending and de-duplicated. */
export function splitFrames(edits: Edits, trackId: string): number[] {
  return [...new Set(edits.splits.filter((s) => s.trackId === trackId).map((s) => s.frame))].sort(
    (a, b) => a - b,
  );
}

/** `t2` + split at 45 -> t2a (<45), t2b (>=45). Unsplit tracks keep their id. */
export function pieces(doc: TracksDoc, edits: Edits): Piece[] {
  const out: Piece[] = [];
  for (const track of doc.tracks) {
    const cuts = splitFrames(edits, track.id);
    if (cuts.length === 0) {
      out.push({ id: track.id, trackId: track.id, track, from: -Infinity, to: Infinity });
      continue;
    }
    const bounds = [-Infinity, ...cuts, Infinity];
    for (let i = 0; i < bounds.length - 1; i++) {
      out.push({
        id: `${track.id}${LETTERS[i] ?? String(i)}`,
        trackId: track.id,
        track,
        from: bounds[i],
        to: bounds[i + 1] - 1,
      });
    }
  }
  return out;
}

export function pieceFrames(p: Piece): number[] {
  return Object.keys(p.track.frames)
    .map(Number)
    .filter((f) => f >= p.from && f <= p.to)
    .sort((a, b) => a - b);
}

/** Segments of the track clipped to the piece range. */
export function pieceSegments(p: Piece): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of p.track.segments) {
    const s = Math.max(a, p.from);
    const e = Math.min(b, p.to);
    if (s <= e) out.push([s, e]);
  }
  return out;
}

/** Ids treated as visible: edits.visible plus members of any visible group id. */
export function visibleIds(edits: Edits): Set<string> {
  const v = new Set(edits.visible);
  for (const g of edits.groups) {
    if (v.has(g.id)) g.trackIds.forEach((t) => v.add(t));
  }
  return v;
}
