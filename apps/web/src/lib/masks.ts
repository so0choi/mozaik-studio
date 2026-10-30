import { pieces, visibleIds } from './pieces';
import type { Edits, ManualDoc, MaskBox, TracksDoc } from './types';

function manualBlock(w: number, h: number): number {
  return Math.max(8, Math.floor(Math.min(w, h) / 8));
}

/**
 * Per-frame boxes to mosaic. Same rules as worker compose.mask_boxes:
 * - default is mosaic; only `visible` piece ids (or group ids, expanded) are skipped
 * - split at F: `<id>a` covers < F, `<id>b` covers >= F
 * - track boxes are already expanded and use the track's fixed blockSize
 * - manual: skip deleted; trim keeps frames in [t0, t1]; block = max(8, min(w,h)//8)
 * Boxes per frame are sorted by (x, y).
 */
export function maskBoxes(
  doc: TracksDoc,
  edits: Edits,
  manual: ManualDoc[],
): Map<number, MaskBox[]> {
  const visible = visibleIds(edits);
  const out = new Map<number, MaskBox[]>();
  const push = (frame: number, b: MaskBox) => {
    const list = out.get(frame);
    if (list) list.push(b);
    else out.set(frame, [b]);
  };

  for (const p of pieces(doc, edits)) {
    if (visible.has(p.id)) continue;
    for (const [k, box] of Object.entries(p.track.frames)) {
      const f = Number(k);
      if (f < p.from || f > p.to) continue;
      push(f, [box[0], box[1], box[2], box[3], p.track.blockSize]);
    }
  }

  const docs = new Map(manual.map((m) => [m.id, m]));
  for (const m of edits.manual) {
    if (m.deleted) continue;
    const d = docs.get(m.id);
    if (d) {
      for (const [k, box] of Object.entries(d.frames)) {
        const f = Number(k);
        if (m.trim && (f < m.trim[0] || f > m.trim[1])) continue;
        push(f, [box[0], box[1], box[2], box[3], manualBlock(box[2], box[3])]);
      }
    } else {
      // propagation missing or failed: keep only the drawn anchor frames as fixed boxes
      for (const a of m.anchors) {
        if (m.trim && (a.frame < m.trim[0] || a.frame > m.trim[1])) continue;
        push(a.frame, [a.box[0], a.box[1], a.box[2], a.box[3], manualBlock(a.box[2], a.box[3])]);
      }
    }
  }

  for (const list of out.values()) list.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}
