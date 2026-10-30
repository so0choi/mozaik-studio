import { MANUAL_ID_RE } from './storage';

export const DEFAULT_EDITS = () => ({ version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [] });

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isBox = (v: unknown): boolean =>
  Array.isArray(v) && v.length === 4 && v.every(isInt) && v[2] > 0 && v[3] > 0;

export function isValidBox(v: unknown) {
  return isBox(v);
}

/** Returns an error message (Korean) or null when valid. Spec §3.5. */
export function validateEdits(
  e: any,
  trackIds: Set<string>,
  reviewIds: Set<string>,
): string | null {
  const bad = '편집 내용 형식이 올바르지 않습니다.';
  if (!e || typeof e !== 'object' || Array.isArray(e)) return bad;
  if (e.version !== 1) return bad;
  if (!isStrArr(e.visible) || !isStrArr(e.reviewed)) return bad;
  if (!Array.isArray(e.groups) || !Array.isArray(e.splits) || !Array.isArray(e.manual)) return bad;

  const known = new Set(trackIds);
  for (const s of e.splits) {
    if (!s || !isStr(s.trackId) || !isInt(s.frame) || s.frame < 0) return bad;
    if (!trackIds.has(s.trackId)) return `알 수 없는 트랙입니다: ${s.trackId}`;
    known.add(`${s.trackId}a`);
    known.add(`${s.trackId}b`);
  }
  for (const g of e.groups) {
    if (!g || !isStr(g.id) || !isStrArr(g.trackIds) || typeof g.label !== 'string' || g.label.length > 200) return bad;
    for (const t of g.trackIds) if (!known.has(t)) return `알 수 없는 트랙입니다: ${t}`;
  }
  for (const t of e.visible) if (!known.has(t)) return `알 수 없는 트랙입니다: ${t}`;
  for (const r of e.reviewed) if (!reviewIds.has(r)) return `알 수 없는 확인 항목입니다: ${r}`;

  for (const m of e.manual) {
    if (!m || typeof m.id !== 'string' || !MANUAL_ID_RE.test(m.id)) return bad;
    if (!Array.isArray(m.anchors)) return bad;
    for (const a of m.anchors) {
      if (!a || !isInt(a.frame) || a.frame < 0 || !isBox(a.box)) return bad;
    }
    if (m.trim !== null && !(Array.isArray(m.trim) && m.trim.length === 2 && m.trim.every(isInt))) return bad;
    if (typeof m.deleted !== 'boolean') return bad;
  }
  return null;
}
