import { normalizeEffects, regionBlock } from './effectParams';
import { pieces, visibleIds } from './pieces';
import type { Box, Edits, Effect, ManualDoc, ManualEdit, MaskBox, Region, Shape, TracksDoc } from './types';

/** Line-by-line port of worker/mosaic_worker/compose.py (mask_regions). An exposed face is the worst failure: keep the two in sync. */

function manualBlock(w: number, h: number): number {
  return Math.max(8, Math.floor(Math.min(w, h) / 8));
}

/**
 * Effect of one masked piece (spec 3.2): piece override (split pieces only), the FIRST group
 * containing the track or piece (without an override there we fall through to the track override,
 * never to a later group), track override, then the default.
 */
function effectFor(pieceId: string, trackId: string, edits: Edits): Effect {
  const fx = normalizeEffects(edits);
  const ov = fx.overrides;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(ov, k);
  if (pieceId !== trackId && has(pieceId)) return ov[pieceId];
  for (const g of edits.groups ?? []) {
    const ids = g.trackIds ?? [];
    if (ids.includes(trackId) || ids.includes(pieceId)) {
      if (has(g.id)) return ov[g.id];
      break;
    }
  }
  if (has(trackId)) return ov[trackId];
  return fx.default;
}

/**
 * Map normalized polygon points (u, v) drawn on box D to frame box B through the linear box map
 * from the anchor frame's propagated box A: P = B.xy + (P_drawn - A.xy) * (B.wh / A.wh), rounded
 * half up. Null for a degenerate A or B (caller uses rect).
 */
function polyPoints(
  shapePts: [number, number][],
  D: Box,
  A: Box,
  B: Box,
): [number, number][] | null {
  if (Math.min(A[2], A[3], B[2], B[3]) <= 0) return null;
  const [dx, dy, dw, dh] = D;
  const sx = B[2] / A[2];
  const sy = B[3] / A[3];
  return shapePts.map(([u, v]) => {
    const px = dx + u * dw;
    const py = dy + v * dh;
    return [Math.floor(B[0] + (px - A[0]) * sx + 0.5), Math.floor(B[1] + (py - A[1]) * sy + 0.5)];
  });
}

function makeRegion(
  id: string,
  box: Box,
  block: number,
  effect: Effect,
  shape: Shape = 'rect',
  points: [number, number][] | null = null,
): Region {
  return {
    id,
    shape,
    box: [Math.trunc(box[0]), Math.trunc(box[1]), Math.trunc(box[2]), Math.trunc(box[3])],
    points,
    effect,
    block,
  };
}

function manualShape(e: ManualEdit): { shape: Shape; pts: [number, number][] | null } {
  const shape = e.shape ?? 'rect';
  const pts = e.points;
  if (shape === 'polygon' && pts && pts.length > 0) return { shape: 'polygon', pts };
  if (shape === 'ellipse') return { shape: 'ellipse', pts: null };
  return { shape: 'rect', pts: null };
}

/** {frame: [Region, ...]} sorted by (x, y); frames without regions are absent. */
export function maskRegions(
  doc: TracksDoc,
  edits: Edits,
  manual: ManualDoc[],
): Map<number, Region[]> {
  const vis = visibleIds(edits);
  const perFrame = new Map<number, Region[]>();
  const push = (frame: number, r: Region) => {
    const list = perFrame.get(frame);
    if (list) list.push(r);
    else perFrame.set(frame, [r]);
  };

  for (const p of pieces(doc, edits)) {
    if (vis.has(p.id)) continue;
    const eff = effectFor(p.id, p.trackId, edits);
    for (const [k, box] of Object.entries(p.track.frames)) {
      const f = Number(k);
      if (f < p.from || f > p.to) continue;
      push(f, makeRegion(p.id, box, regionBlock(p.track.blockSize, eff.strength), eff));
    }
  }

  const editById = new Map((edits.manual ?? []).map((m) => [m.id, m]));
  const defaultEffect = normalizeEffects(edits).default;

  for (const d of manual ?? []) {
    const e = editById.get(d.id);
    if (e?.deleted) continue;
    const trim = e?.trim ?? null;
    const { shape, pts } = e ? manualShape(e) : { shape: 'rect' as Shape, pts: null };
    const eff = e ? effectFor(d.id, d.id, edits) : defaultEffect;
    const docFrames = new Map<number, Box>(Object.entries(d.frames ?? {}).map(([k, b]) => [Number(k), b]));
    // nearest anchor (frame distance, ties to the earlier anchor) that has a propagated box
    const anchors = (e?.anchors ?? [])
      .filter((a) => docFrames.has(Number(a.frame)))
      .map((a) => [Number(a.frame), a.box] as [number, Box])
      .sort((a, b) => a[0] - b[0]);
    for (const [f, rawBox] of docFrames) {
      if (trim && !(trim[0] <= f && f <= trim[1])) continue;
      const box: Box = [Math.trunc(rawBox[0]), Math.trunc(rawBox[1]), Math.trunc(rawBox[2]), Math.trunc(rawBox[3])];
      let points: [number, number][] | null = null;
      if (shape === 'polygon' && anchors.length > 0) {
        let best = anchors[0];
        for (const a of anchors) {
          const da = Math.abs(a[0] - f);
          const db = Math.abs(best[0] - f);
          if (da < db || (da === db && a[0] < best[0])) best = a;
        }
        points = polyPoints(pts!, best[1], docFrames.get(best[0])!, box);
      }
      push(
        f,
        makeRegion(
          d.id,
          box,
          regionBlock(manualBlock(box[2], box[3]), eff.strength),
          eff,
          shape !== 'polygon' || points ? shape : 'rect',
          points,
        ),
      );
    }
  }

  // Propagation missing or failed: mask the drawn anchor frames as fixed boxes,
  // matching the worker so a face covered there is never exposed in the output.
  const docIds = new Set((manual ?? []).map((d) => d.id));
  for (const e of edits.manual ?? []) {
    if (e.deleted || docIds.has(e.id)) continue;
    const trim = e.trim;
    const { shape, pts } = manualShape(e);
    const eff = effectFor(e.id, e.id, edits);
    for (const a of e.anchors ?? []) {
      const f = Number(a.frame);
      if (trim && !(trim[0] <= f && f <= trim[1])) continue;
      const box: Box = [Math.trunc(a.box[0]), Math.trunc(a.box[1]), Math.trunc(a.box[2]), Math.trunc(a.box[3])];
      const points = shape === 'polygon' ? polyPoints(pts!, box, box, box) : null;
      push(
        f,
        makeRegion(
          e.id,
          box,
          regionBlock(manualBlock(box[2], box[3]), eff.strength),
          eff,
          shape !== 'polygon' || points ? shape : 'rect',
          points,
        ),
      );
    }
  }

  for (const list of perFrame.values()) list.sort((a, b) => a.box[0] - b.box[0] || a.box[1] - b.box[1]);
  return perFrame;
}

/** Temporary (rect mosaic drawing): region -> [x, y, w, h, block]. Replaced when region drawing lands. */
export function regionBoxes(regions: Map<number, Region[]>): Map<number, MaskBox[]> {
  const out = new Map<number, MaskBox[]>();
  for (const [f, rs] of regions) {
    out.set(f, rs.map((r) => [r.box[0], r.box[1], r.box[2], r.box[3], r.block]));
  }
  return out;
}
