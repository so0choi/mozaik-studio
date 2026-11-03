import { describe, expect, it } from 'vitest';
import { effectFor } from './masks';
import { normalizeEffect, normalizeEffects, backgroundBlock, backgroundSigma, regionBlock, regionSigma } from './effectParams';
import { effectParamCases } from './fixtures';

const fns: Record<string, (...a: number[]) => number> = {
  region_block: regionBlock,
  region_sigma: regionSigma,
  background_block: backgroundBlock,
  background_sigma: backgroundSigma,
};

describe('effect params (shared fixture with worker effects)', () => {
  it('has cases', () => expect(effectParamCases.length).toBeGreaterThan(0));
  for (const c of effectParamCases) {
    it(`${c.fn}(${c.args.join(', ')}) = ${c.expected}`, () => {
      const fn = fns[c.fn];
      expect(fn, `unmapped fn ${c.fn}`).toBeDefined();
      expect(fn(...c.args)).toBeCloseTo(c.expected, 9);
    });
  }
});

describe('normalizeEffects prototype safety', () => {
  const evil = JSON.parse(
    '{"effects":{"default":{},"overrides":{"__proto__":{"type":"blur"},"constructor":{"type":"blur"},"prototype":{"type":"blur"},"t1":{"type":"color"}}}}',
  );

  it('skips reserved keys and never touches the prototype', () => {
    const n = normalizeEffects(evil);
    expect(Object.keys(n.overrides)).toEqual(['t1']);
    expect(Object.getPrototypeOf(n.overrides)).not.toEqual(expect.objectContaining({ type: 'blur' }));
    expect(({} as Record<string, unknown>).type).toBeUndefined();
    expect((n.overrides as Record<string, unknown>).type).toBeUndefined();
  });

  it('effectFor ignores reserved ids and still reads own overrides', () => {
    const edits = { ...evil, groups: [], visible: [] } as never;
    expect(effectFor('constructor', 'constructor', edits).type).toBe('blur');
    expect(effectFor('t1', 't1', edits).type).toBe('color');
  });

  it('background is an effect only for a plain non-empty object', () => {
    const bg = (b: unknown) => normalizeEffects({ effects: { background: b } } as never).background;
    expect(bg({})).toBeNull();
    expect(bg([1])).toBeNull();
    expect(bg('blur')).toBeNull();
    expect(bg(1)).toBeNull();
    expect(bg(null)).toBeNull();
    expect(bg({ type: 'blur' })?.type).toBe('blur');
  });
});

describe('default effect', () => {
  it('is blur when type is missing or invalid; an explicit type is kept', () => {
    expect(normalizeEffect(undefined).type).toBe('blur');
    expect(normalizeEffect({ type: 'nope' }).type).toBe('blur');
    expect(normalizeEffect({ type: 'mosaic' }).type).toBe('mosaic');
  });
});
