import { describe, expect, it } from 'vitest';
import { maskRegions } from './masks';
import { splitTrack, groupPersons } from './edits';
import { tracksDoc, edits, manualDocs, expectedRegions } from './fixtures';
import type { Edits, Effect, ManualDoc } from './types';

const E = (type: Effect['type'], strength = 1, color = '#000000'): Effect => ({ type, strength, color });
const blank = (over: Partial<Edits> = {}): Edits => ({
  version: 1, visible: [], groups: [], splits: [], manual: [], reviewed: [], ...over,
});
const withFx = (overrides: Record<string, Effect>, over: Partial<Edits> = {}): Edits =>
  blank({ effects: { default: E('mosaic'), background: null, overrides }, ...over });
const toObj = (m: Map<number, unknown>) => Object.fromEntries([...m].map(([k, v]) => [String(k), v]));

describe('maskRegions (shared fixture with worker compose)', () => {
  const m = maskRegions(tracksDoc, edits, manualDocs);

  it('reproduces expected-regions.json exactly', () => {
    // the fixture lists a sample of frames (like the worker test); compare exactly those
    const all = toObj(m);
    for (const [k, v] of Object.entries(expectedRegions)) {
      if (k.startsWith('_')) continue;
      expect(all[k], `frame ${k}`).toEqual(v);
    }
    expect(all['89']).toBeUndefined();
  });

  it('puts split boundary frame 45 on t2b (visible) so t2a box is gone', () => {
    expect(m.get(44)!.some((r) => r.box[0] === 300)).toBe(true);
    expect((m.get(45) ?? []).some((r) => r.box[0] === 300)).toBe(false);
  });

  it('ignores deleted manual m2 and trims m1 to 44..46', () => {
    expect((m.get(10) ?? []).some((r) => r.box[0] === 10)).toBe(false);
    expect((m.get(43) ?? []).some((r) => r.box[0] === 200)).toBe(false);
    expect((m.get(46) ?? []).some((r) => r.box[0] === 200)).toBe(true);
    expect((m.get(47) ?? []).some((r) => r.box[0] === 200)).toBe(false);
  });

  it('masks everything by default', () => {
    expect(maskRegions(tracksDoc, blank(), []).get(0)!.length).toBe(2);
  });

  it('visible group id expands to its tracks', () => {
    const e = blank({ visible: ['g1'], groups: [{ id: 'g1', trackIds: ['t1', 't2'] }] });
    expect(maskRegions(tracksDoc, e, []).get(0)).toBeUndefined();
  });

  it('falls back to a fixed anchor-frame box when a manual doc is missing', () => {
    const e = blank({
      visible: ['t1', 't2'],
      manual: [{ id: 'm9', anchors: [{ frame: 7, box: [10, 20, 80, 64] }], trim: null, deleted: false }],
    });
    expect(maskRegions(tracksDoc, e, []).get(7)).toEqual([
      { id: 'm9', shape: 'rect', box: [10, 20, 80, 64], points: null, effect: E('mosaic'), block: 8 },
    ]);
  });

  it('masks a manual doc that has no edits.manual entry (matches the worker)', () => {
    const doc: ManualDoc = { id: 'mx', frames: { '3': [5, 6, 40, 40] }, segments: [[3, 3]] };
    const r = maskRegions(tracksDoc, withFx({ mx: E('blur', 2) }), [doc]).get(3)!.filter((x) => x.id === 'mx');
    expect(r).toEqual([{ id: 'mx', shape: 'rect', box: [5, 6, 40, 40], points: null, effect: E('mosaic'), block: 8 }]);
  });
});

describe('maskRegions effect priority', () => {
  const t1 = (e: Edits) => maskRegions(tracksDoc, e, []).get(0)!.find((r) => r.id === 't1')!;

  it('group beats track', () => {
    const e = withFx({ g1: E('blur', 3), t1: E('color', 1, '#ff0000') }, { groups: [{ id: 'g1', trackIds: ['t1', 't2'] }] });
    expect(t1(e).effect).toEqual(E('blur', 3));
  });

  it('group without override falls through to the track override, not a later group', () => {
    const e = withFx(
      { t1: E('color', 1, '#00ff00'), g2: E('blur') },
      { groups: [{ id: 'g1', trackIds: ['t1'] }, { id: 'g2', trackIds: ['t1'] }] },
    );
    expect(t1(e).effect).toEqual(E('color', 1, '#00ff00'));
  });

  it('first matching group wins in groups order', () => {
    const e = withFx(
      { g1: E('blur', 2), g2: E('color') },
      { groups: [{ id: 'g1', trackIds: ['t1'] }, { id: 'g2', trackIds: ['t1'] }] },
    );
    expect(t1(e).effect).toEqual(E('blur', 2));
  });

  it('split piece override beats group', () => {
    const e = withFx(
      { t2a: E('color', 1, '#123456'), g1: E('blur') },
      { splits: [{ trackId: 't2', frame: 45 }], groups: [{ id: 'g1', trackIds: ['t2a', 't2b'] }] },
    );
    const r = maskRegions(tracksDoc, e, []).get(0)!.find((x) => x.id === 't2a')!;
    expect(r.effect).toEqual(E('color', 1, '#123456'));
  });

  it('ignores unknown override keys', () => {
    const e = withFx({ nope: E('blur', 5), g9: E('color') });
    expect(t1(e).effect).toEqual(E('mosaic'));
  });

  it('block scales with strength for every effect type', () => {
    const e = withFx({ t1: E('blur', 3) });
    expect(t1(e).block).toBe(t1(blank()).block * 2);
  });

  it('group membership after real splitTrack applies to both pieces', () => {
    let e = withFx({ g1: E('blur', 2) }, { groups: [{ id: 'g1', trackIds: ['t1', 't2'] }] });
    e = splitTrack(e, 't2', 45);
    const m = maskRegions(tracksDoc, e, []);
    const a = m.get(44)!.find((r) => r.id === 't2a')!;
    const b = m.get(46)!.find((r) => r.id === 't2b')!;
    expect(a.effect).toEqual(E('blur', 2));
    expect(b.effect).toEqual(E('blur', 2));
  });
});

describe('maskRegions polygons', () => {
  const mp = (m: Map<number, import('./types').Region[]>, f: number) => m.get(f)!.find((r) => r.id === 'mp')!;
  const pts: [number, number][] = [[0, 0], [1, 0], [0.5, 1]];
  const mk = (frames: Record<string, [number, number, number, number]>, anchors: { frame: number; box: [number, number, number, number] }[]) => ({
    doc: { id: 'mp', frames, segments: [] } as ManualDoc,
    e: blank({ manual: [{ id: 'mp', shape: 'polygon', points: pts, anchors, trim: null, deleted: false }] }),
  });

  it('scales with the propagated box and rounds half up', () => {
    const { doc, e } = mk({ '10': [100, 100, 60, 40], '11': [110, 100, 30, 20] }, [{ frame: 10, box: [100, 100, 60, 40] }]);
    const m = maskRegions(tracksDoc, e, [doc]);
    expect(mp(m, 10).points).toEqual([[100, 100], [160, 100], [130, 140]]);
    expect(mp(m, 11).points).toEqual([[110, 100], [140, 100], [125, 120]]);
  });

  it('degenerate box falls back to rect', () => {
    const { doc, e } = mk({ '10': [100, 100, 60, 40], '11': [110, 100, 0, 20] }, [{ frame: 10, box: [100, 100, 60, 40] }]);
    const r = mp(maskRegions(tracksDoc, e, [doc]), 11);
    expect(r.shape).toBe('rect');
    expect(r.points).toBeNull();
  });

  it('nearest anchor wins, tie goes to the earlier one', () => {
    const { doc, e } = mk(
      { '10': [0, 0, 10, 10], '12': [20, 0, 10, 10], '11': [10, 0, 10, 10] },
      [{ frame: 12, box: [20, 0, 10, 10] }, { frame: 10, box: [0, 0, 10, 10] }],
    );
    // drawn on different boxes so the choice is visible
    e.manual[0].anchors = [{ frame: 12, box: [20, 0, 20, 20] }, { frame: 10, box: [0, 0, 10, 10] }];
    const p = mp(maskRegions(tracksDoc, e, [doc]), 11).points!;
    // anchor 10: D=A=[0,0,10,10] -> B=[10,0,10,10] => [[10,0],[20,0],[15,10]]
    expect(p).toEqual([[10, 0], [20, 0], [15, 10]]);
  });

  it('anchor fallback without a manual doc draws on the drawn box', () => {
    const e = blank({ manual: [{ id: 'mp', shape: 'polygon', points: pts, anchors: [{ frame: 5, box: [10, 20, 80, 40] }], trim: null, deleted: false }] });
    const r = mp(maskRegions(tracksDoc, e, []), 5);
    expect(r.shape).toBe('polygon');
    expect(r.points).toEqual([[10, 20], [90, 20], [50, 60]]);
  });
});

describe('groupPersons effects (used by masks)', () => {
  it('moved override reaches the new group members', () => {
    const e = groupPersons(tracksDoc, withFx({ t1: E('blur', 2) }), ['t1', 't2']);
    const r = maskRegions(tracksDoc, e, []).get(0)!;
    expect(r.every((x) => x.effect.type === 'blur')).toBe(true);
  });
});
