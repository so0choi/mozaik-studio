import { MANUAL_ID_RE } from './storage';

export const DEFAULT_EDITS = () => ({
  version: 1,
  visible: [],
  groups: [],
  splits: [],
  manual: [],
  reviewed: [],
  effects: { default: { type: 'mosaic', strength: 1 }, background: null, overrides: {} },
});

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const EFFECT_TYPES = new Set(['mosaic', 'blur', 'color']);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const isEffect = (v: unknown): boolean => {
  if (!isObj(v) || typeof v.type !== 'string' || !EFFECT_TYPES.has(v.type)) return false;
  if (v.strength !== undefined && !(isInt(v.strength) && v.strength >= 1 && v.strength <= 5)) return false;
  if (v.color !== undefined && !(typeof v.color === 'string' && COLOR_RE.test(v.color))) return false;
  return true;
};
const isUnit = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const MAX_POINTS = 256;
const MAX_ANCHORS = 500;
const COORD_MAX = 16384;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MIN_UNIT_AREA = 1e-9; // below this the polygon is a line/point (float noise on collinear input)
const isPoints = (v: unknown): boolean => {
  if (!Array.isArray(v) || v.length < 3 || v.length > MAX_POINTS) return false;
  if (!v.every((p) => Array.isArray(p) && p.length === 2 && p.every(isUnit))) return false;
  let a = 0;
  for (let i = 0; i < v.length; i++) {
    const [x1, y1] = v[i];
    const [x2, y2] = v[(i + 1) % v.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2 >= MIN_UNIT_AREA;
};

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isBox = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length === 4 &&
  v.every(isInt) &&
  Math.abs(v[0]) <= COORD_MAX &&
  Math.abs(v[1]) <= COORD_MAX &&
  v[2] >= 1 &&
  v[2] <= COORD_MAX &&
  v[3] >= 1 &&
  v[3] <= COORD_MAX;

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
    if (RESERVED_KEYS.has(g.id)) return bad;
    for (const t of g.trackIds) if (!known.has(t)) return `알 수 없는 트랙입니다: ${t}`;
  }
  for (const t of e.visible) if (!known.has(t)) return `알 수 없는 트랙입니다: ${t}`;
  for (const r of e.reviewed) if (!reviewIds.has(r)) return `알 수 없는 확인 항목입니다: ${r}`;

  for (const m of e.manual) {
    if (!m || typeof m.id !== 'string' || !MANUAL_ID_RE.test(m.id)) return bad;
    if (!Array.isArray(m.anchors) || m.anchors.length > MAX_ANCHORS) return bad;
    for (const a of m.anchors) {
      if (!a || !isInt(a.frame) || a.frame < 0 || !isBox(a.box)) return bad;
    }
    if (m.trim !== null && !(Array.isArray(m.trim) && m.trim.length === 2 && m.trim.every(isInt))) return bad;
    if (typeof m.deleted !== 'boolean') return bad;
    if (m.shape !== undefined && !['rect', 'ellipse', 'polygon'].includes(m.shape)) return bad;
    if (m.shape === 'polygon') {
      if (!isPoints(m.points)) return bad;
    } else if (m.points !== undefined) return bad;
  }

  if (e.effects !== undefined) {
    const fx = e.effects;
    if (!isObj(fx) || !isEffect(fx.default)) return bad;
    if (fx.background !== null && fx.background !== undefined && !isEffect(fx.background)) return bad;
    if (fx.overrides !== undefined) {
      if (!isObj(fx.overrides)) return bad;
      const targets = new Set(known);
      for (const g of e.groups) targets.add(g.id);
      for (const m of e.manual) targets.add(m.id);
      for (const [key, val] of Object.entries(fx.overrides)) {
        if (RESERVED_KEYS.has(key)) return bad;
        if (!targets.has(key)) return `알 수 없는 대상입니다: ${key}`;
        if (!isEffect(val)) return bad;
      }
    }
  }
  return null;
}
