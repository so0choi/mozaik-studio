// Effect parameters (spec 3.3). Must match worker/mosaic_worker/effects.py; checked against
// contracts/fixtures/effect-params.json. Integer results round half up (Math.round on non-negatives).
import type { Edits, Effect, EffectType, Effects } from './types';

const EFFECT_TYPES: readonly EffectType[] = ['mosaic', 'blur', 'color'];
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const DEFAULT_COLOR = '#000000';

export function normalizeEffect(eff: unknown): Effect {
  const e = (eff && typeof eff === 'object' ? eff : {}) as Record<string, unknown>;
  const t = e.type;
  const s = e.strength;
  const c = e.color;
  return {
    type: EFFECT_TYPES.includes(t as EffectType) ? (t as EffectType) : 'blur',
    strength: typeof s === 'number' && Number.isInteger(s) && s >= 1 && s <= 5 ? s : 1,
    color: typeof c === 'string' ? c : DEFAULT_COLOR,
  };
}

/** Missing / partial effects filled with defaults, same as the worker's normalize_effects. */
export function normalizeEffects(edits: Partial<Edits> | null | undefined): Effects {
  const fx = (edits?.effects ?? {}) as Partial<Effects>;
  const bg = fx.background;
  // null prototype + reserved keys skipped: a "__proto__" key can never reach a setter or the prototype
  const overrides: Record<string, Effect> = Object.create(null);
  for (const [k, v] of Object.entries(fx.overrides ?? {})) {
    if (RESERVED_KEYS.has(k)) continue;
    overrides[k] = normalizeEffect(v);
  }
  return {
    default: normalizeEffect(fx.default),
    background: bg && typeof bg === 'object' && !Array.isArray(bg) && Object.keys(bg).length > 0 ? normalizeEffect(bg) : null,
    overrides,
  };
}

export function strengthFactor(s: number): number {
  return 1 + 0.5 * (s - 1);
}

export function regionBlock(base: number, s: number): number {
  return Math.round(base * strengthFactor(s));
}

export function regionSigma(w: number, h: number, s: number): number {
  return Math.max(Math.min(w, h) / 4, 2) * strengthFactor(s);
}

export function backgroundBlock(W: number, H: number, s: number): number {
  return Math.round(Math.max(8, Math.floor(Math.min(W, H) / 40)) * strengthFactor(s));
}

export function backgroundSigma(W: number, H: number, s: number): number {
  return (Math.min(W, H) / 60) * strengthFactor(s);
}
