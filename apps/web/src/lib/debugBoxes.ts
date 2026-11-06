import type { Box, Edits, ManualDoc, TracksDoc } from './types';

export type DebugKind = 'detected' | 'held' | 'suspect' | 'manual';
export type DebugState = '가림' | '보임' | '일부 보임';

export interface DebugBox {
  id: string;
  kind: DebugKind;
  box: Box;
  score: number | null;
  state: DebugState | null;
  label: string;
}

function stateOf(id: string, visible: Set<string>): DebugState {
  if (visible.has(id)) return '보임';
  const a = visible.has(`${id}a`);
  const b = visible.has(`${id}b`);
  if (a && b) return '보임';
  if (a || b) return '일부 보임';
  return '가림';
}

/** Detector/manual boxes present at a frame, for the preview-only debug overlay. */
export function debugBoxesAt(
  frame: number,
  tracks: TracksDoc,
  edits: Pick<Edits, 'visible' | 'manual'>,
  manualDocs: ManualDoc[],
): DebugBox[] {
  const key = String(frame);
  const visible = new Set(edits.visible);
  const out: DebugBox[] = [];
  for (const t of tracks.tracks) {
    const box = t.frames[key];
    if (!box) continue;
    const score = t.scores?.[key] ?? null;
    const state = stateOf(t.id, visible);
    const suspect = !!(t.suspect || t.nonface);
    const kind: DebugKind = suspect ? 'suspect' : score !== null ? 'detected' : 'held';
    const sc = score !== null ? score.toFixed(2) : '유지';
    const label = `${t.id} ${sc}${suspect ? ' 의심' : ''} · ${state}`;
    out.push({ id: t.id, kind, box, score, state, label });
  }
  const deleted = new Set(edits.manual.filter((m) => m.deleted).map((m) => m.id));
  for (const m of manualDocs) {
    const box = m.frames[key];
    if (!box || deleted.has(m.id)) continue;
    out.push({ id: m.id, kind: 'manual', box, score: null, state: null, label: m.id });
  }
  return out;
}

/** mm:ss.cc from frame/fps (rounded to centiseconds). */
export function debugTime(frame: number, fps: number): string {
  const cs = Math.round((frame / fps) * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(m)}:${p(s)}.${p(c)}`;
}

export function debugFrameText(jobId: string, frame: number, fps: number, boxes: DebugBox[]): string {
  const lines = [`작업 ${jobId} · 프레임 ${frame} · ${debugTime(frame, fps)}`];
  if (boxes.length === 0) lines.push('박스 없음');
  for (const b of boxes) {
    const score = b.score !== null ? b.score.toFixed(2) : '-';
    lines.push(`${b.id} ${b.kind} ${score} ${b.state ?? '-'} [${b.box.join(',')}]`);
  }
  return lines.join('\n');
}
