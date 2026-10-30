import { describe, expect, it } from 'vitest';
import { maskBoxes } from './masks';
import { tracksDoc, edits, manualDocs, expected } from './fixtures';
import type { Edits } from './types';

describe('maskBoxes (shared fixture with worker compose)', () => {
  const m = maskBoxes(tracksDoc, edits, manualDocs);

  it('reproduces expected-mask-frames.json exactly', () => {
    for (const [k, v] of Object.entries(expected)) {
      if (k.startsWith('_')) continue;
      expect(m.get(Number(k)) ?? [], `frame ${k}`).toEqual(v);
    }
  });

  it('puts split boundary frame 45 on t2b (visible) so t2a box is gone', () => {
    expect(m.get(44)!.some((b) => b[0] === 300)).toBe(true);
    expect((m.get(45) ?? []).some((b) => b[0] === 300)).toBe(false);
  });

  it('ignores deleted manual m2 and trims m1 to 44..46', () => {
    expect((m.get(10) ?? []).some((b) => b[0] === 10)).toBe(false);
    expect((m.get(43) ?? []).some((b) => b[0] === 200)).toBe(false);
    expect((m.get(46) ?? []).some((b) => b[0] === 200)).toBe(true);
    expect((m.get(47) ?? []).some((b) => b[0] === 200)).toBe(false);
  });

  it('masks everything by default', () => {
    const none: Edits = { version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [] };
    const all = maskBoxes(tracksDoc, none, []);
    expect(all.get(0)!.length).toBe(2);
  });

  it('visible group id expands to its tracks', () => {
    const e: Edits = {
      version: 1, visible: ['g1'], groups: [{ id: 'g1', trackIds: ['t1', 't2'] }],
      splits: [], manual: [], reviewed: [],
    };
    expect(maskBoxes(tracksDoc, e, []).get(0)).toBeUndefined();
  });

  it('falls back to a fixed anchor-frame box when a manual doc is missing', () => {
    const e: Edits = {
      version: 1, visible: ['t1', 't2'], groups: [], splits: [], reviewed: [],
      manual: [{ id: 'm9', anchors: [{ frame: 7, box: [10, 20, 80, 64] }], trim: null, deleted: false }],
    };
    expect(maskBoxes(tracksDoc, e, []).get(7)).toEqual([[10, 20, 80, 64, 8]]);
  });
});
