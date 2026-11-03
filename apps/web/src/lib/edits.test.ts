import { describe, expect, it } from 'vitest';
import {
  addManualAnchor, addManualEdit, deleteManual, emptyEdits, groupPersons, normalizeEdits, splitTrack,
  setBackgroundEffect, setDefaultEffect, setManualTrim, setPersonEffect, setTargetEffect, uncoverPerson, unmaskPiece,
} from './edits';
import { tracksDoc } from './fixtures';
import { effectFor } from './masks';
import { enlargeBox } from './geometry';
import type { Edits } from './types';

const base = (): Edits => ({
  ...emptyEdits(),
  manual: [
    { id: 'm1', anchors: [{ frame: 10, box: [1, 2, 3, 4] }], trim: null, deleted: false },
    { id: 'm2', anchors: [{ frame: 5, box: [9, 9, 9, 9] }], trim: null, deleted: false },
  ],
});

describe('setManualTrim', () => {
  it('sets and clears trim on only the named manual edit', () => {
    const a = setManualTrim(base(), 'm1', [10, 20]);
    expect(a.manual[0].trim).toEqual([10, 20]);
    expect(a.manual[1].trim).toBeNull();
    expect(setManualTrim(a, 'm1', null).manual[0].trim).toBeNull();
  });
  it('returns the same object for an unknown id', () => {
    const e = base();
    expect(setManualTrim(e, 'zz', [1, 2])).toBe(e);
  });
});

describe('deleteManual', () => {
  it('marks deleted and keeps the entry', () => {
    const a = deleteManual(base(), 'm1');
    expect(a.manual.map((m) => [m.id, m.deleted])).toEqual([
      ['m1', true],
      ['m2', false],
    ]);
  });
});

describe('addManualAnchor', () => {
  it('appends an anchor at a new frame', () => {
    const a = addManualAnchor(base(), 'm1', { frame: 30, box: [5, 5, 5, 5] });
    expect(a.manual[0].anchors).toEqual([
      { frame: 10, box: [1, 2, 3, 4] },
      { frame: 30, box: [5, 5, 5, 5] },
    ]);
  });
  it('replaces an existing anchor at the same frame', () => {
    const a = addManualAnchor(base(), 'm1', { frame: 10, box: [7, 7, 7, 7] });
    expect(a.manual[0].anchors).toEqual([{ frame: 10, box: [7, 7, 7, 7] }]);
  });
  it('does not touch other manual edits', () => {
    const a = addManualAnchor(base(), 'm1', { frame: 30, box: [5, 5, 5, 5] });
    expect(a.manual[1]).toEqual(base().manual[1]);
  });
});

describe('enlargeBox', () => {
  it('grows 30% around the center', () => {
    expect(enlargeBox([100, 100, 100, 100], 1.3, 640, 360)).toEqual([85, 85, 130, 130]);
  });
  it('clamps to the video', () => {
    expect(enlargeBox([0, 0, 100, 100], 1.3, 640, 360)).toEqual([0, 0, 115, 115]);
    expect(enlargeBox([600, 330, 40, 30], 1.3, 640, 360)).toEqual([594, 326, 46, 34]);
  });
});

const blur = { type: 'blur', strength: 2, color: '#000000' } as const;

describe('normalizeEdits fills effect defaults', () => {
  it('missing effects', () => {
    expect(normalizeEdits({}).effects).toEqual({
      default: { type: 'blur', strength: 1, color: '#000000' }, background: null, overrides: {},
    });
  });
  it('missing strength / color and partial objects', () => {
    const e = normalizeEdits({
      effects: {
        default: { type: 'blur' },
        background: { type: 'color', color: '#ff0000' },
        overrides: { t1: { type: 'color' }, t2: { strength: 9, type: 'nope' } },
      } as never,
    });
    expect(e.effects).toEqual({
      default: { type: 'blur', strength: 1, color: '#000000' },
      background: { type: 'color', strength: 1, color: '#ff0000' },
      overrides: {
        t1: { type: 'color', strength: 1, color: '#000000' },
        t2: { type: 'blur', strength: 1, color: '#000000' },
      },
    });
  });
});

describe('effect edit functions', () => {
  it('setTargetEffect sets and removes (null) an override', () => {
    const a = setTargetEffect(emptyEdits(), 't1', blur);
    expect(a.effects!.overrides).toEqual({ t1: blur });
    expect(setTargetEffect(a, 't1', null).effects!.overrides).toEqual({});
  });
  it('setDefaultEffect / setBackgroundEffect', () => {
    const a = setBackgroundEffect(setDefaultEffect(emptyEdits(), blur), blur);
    expect(a.effects!.default).toEqual(blur);
    expect(a.effects!.background).toEqual(blur);
    expect(setBackgroundEffect(a, null).effects!.background).toBeNull();
  });
  it('addManualEdit keeps shape and points', () => {
    const entry = { id: 'm5', anchors: [], trim: null, deleted: false, shape: 'polygon', points: [[0, 0], [1, 0], [0, 1]] } as never;
    expect(addManualEdit(emptyEdits(), entry).manual[0]).toEqual(entry);
  });
});

describe('groupPersons effects', () => {
  it('moves first override and drops stale group keys', () => {
    const e0 = {
      ...emptyEdits(),
      groups: [{ id: 'g1', trackIds: ['t1'] }],
      effects: { default: blur, background: null, overrides: { g1: blur, t3: { ...blur, type: 'color' } } },
    } as never;
    const e = groupPersons(tracksDoc, e0, ['g1', 't3']);
    const newId = e.groups.find((g) => g.id !== 'g1')!.id;
    expect(e.effects!.overrides.g1).toBeUndefined();
    expect(e.effects!.overrides[newId]).toEqual(blur);
  });
});

describe('groupPersons with a split track', () => {
  const red = { type: 'color' as const, strength: 1, color: '#ff0000' };
  const split = () =>
    splitTrack(
      { ...emptyEdits(), effects: { default: blur, background: null, overrides: { t2: red } } } as never,
      't2',
      45,
    );

  it('grouping only t2a keeps the effect of its sibling t2b', () => {
    const e0 = split();
    expect(effectFor('t2b', 't2', e0)).toEqual(red);
    const e = groupPersons(tracksDoc, e0, ['t2a', 't1']);
    expect(effectFor('t2b', 't2', e)).toEqual(red);
    expect(effectFor('t2a', 't2', e)).toEqual(blur); // member: the group (no override) falls to the default
  });
  it('grouping both pieces drops the track override (nothing left to preserve)', () => {
    const e = groupPersons(tracksDoc, split(), ['t2a', 't2b']);
    expect(e.effects!.overrides.t2).toBeUndefined();
    expect(e.effects!.overrides.t2b).toBeUndefined();
  });
  it('does not overwrite a sibling piece override or override a sibling group effect', () => {
    const green = { ...red, color: '#00ff00' };
    const own = split();
    own.effects!.overrides.t2b = green;
    expect(effectFor('t2b', 't2', groupPersons(tracksDoc, own, ['t2a', 't1']))).toEqual(green);
    const inGroup = { ...split(), groups: [{ id: 'g1', trackIds: ['t2b'] }] } as Edits;
    inGroup.effects!.overrides.g1 = green;
    const e = groupPersons(tracksDoc, inGroup, ['t2a', 't1']);
    expect(effectFor('t2b', 't2', e)).toEqual(green);
  });
});

describe('splitTrack effects', () => {
  it('does not add an override for a group without one, nor for a multi-member group', () => {
    const noFx = splitTrack({ ...emptyEdits(), groups: [{ id: 'g1', trackIds: ['t2'] }] }, 't2', 45);
    expect(noFx.effects?.overrides ?? {}).toEqual({});
    const multi = splitTrack(
      { ...emptyEdits(), groups: [{ id: 'g1', trackIds: ['t1', 't2'] }], effects: { default: blur, background: null, overrides: { g1: blur } } } as never,
      't2',
      45,
    );
    expect(multi.effects!.overrides).toEqual({ g1: blur });
  });
});

describe('deleteManual effects', () => {
  it('drops its override', () => {
    const e = setTargetEffect(base(), 'm1', blur);
    expect(deleteManual(e, 'm1').effects!.overrides).toEqual({});
  });
});

describe('setPersonEffect / uncoverPerson', () => {
  const person = (key: string, trackIds: string[], isGroup = false) =>
    ({ key, label: key, trackIds, visible: true, thumb: '', samples: [], fragmentCount: 1, appearSec: 1, segments: [], isGroup, suspect: false }) as never;
  const eff = { type: 'blur' as const, strength: 3, color: '#000000' };

  it('setPersonEffect masks and sets override in one edit', () => {
    const e: Edits = { ...emptyEdits(), visible: ['t1', 't2'] };
    const next = setPersonEffect(tracksDoc, e, person('t1', ['t1']), eff);
    expect(next.visible).toEqual(['t2']);
    expect(next.effects!.overrides).toEqual({ t1: eff });
  });
  it('setPersonEffect on group clears member piece overrides', () => {
    let e: Edits = { ...emptyEdits(), visible: ['t1', 't2'], groups: [{ id: 'g1', trackIds: ['t1', 't2'] }] };
    e = setTargetEffect(setTargetEffect(e, 't1', { type: 'color', strength: 1, color: '#ff0000' }), 't2', eff);
    const next = setPersonEffect(tracksDoc, e, person('g1', ['t1', 't2'], true), eff);
    expect(next.visible).toEqual([]);
    expect(next.effects!.overrides).toEqual({ g1: eff });
  });
  it('uncoverPerson is idempotent', () => {
    const e: Edits = emptyEdits();
    const once = uncoverPerson(tracksDoc, e, person('t1', ['t1']));
    expect(once.visible).toEqual(['t1']);
    expect(uncoverPerson(tracksDoc, once, person('t1', ['t1']))).toBe(once);
  });
});

describe('unmaskPiece', () => {
  const split = (e: Edits): Edits => ({ ...e, splits: [{ trackId: 't2', frame: 45 }] });

  it('ungrouped piece becomes visible and nothing else changes', () => {
    const e = unmaskPiece(tracksDoc, emptyEdits(), 't1');
    expect(e.visible).toEqual(['t1']);
  });
  it('grouped piece leaves the group; the group stays masked with its id and label', () => {
    const e0: Edits = { ...emptyEdits(), groups: [{ id: 'g1', trackIds: ['t1', 't2'], label: '가족' }] };
    const e = unmaskPiece(tracksDoc, e0, 't1');
    expect(e.groups).toEqual([{ id: 'g1', trackIds: ['t2'], label: '가족' }]);
    expect(e.visible).toEqual(['t1']);
  });
  it('a one-member group is dropped', () => {
    const e0: Edits = { ...emptyEdits(), groups: [{ id: 'g1', trackIds: ['t1'] }] };
    const e = unmaskPiece(tracksDoc, e0, 't1');
    expect(e.groups).toEqual([]);
    expect(e.visible).toEqual(['t1']);
  });
  it('split base id in a group is replaced by the sibling piece', () => {
    const e0 = split({ ...emptyEdits(), groups: [{ id: 'g1', trackIds: ['t1', 't2'] }] });
    const e = unmaskPiece(tracksDoc, e0, 't2a');
    expect(e.groups[0].trackIds).toEqual(['t1', 't2b']);
    expect(e.visible).toEqual(['t2a']);
  });
  it('a visible group id is expanded so the other members stay visible', () => {
    const e0: Edits = { ...emptyEdits(), visible: ['g1'], groups: [{ id: 'g1', trackIds: ['t1', 't2'] }] };
    const e = unmaskPiece(tracksDoc, e0, 't1');
    expect(e.visible.sort()).toEqual(['t1', 't2']);
  });
  it('unknown piece returns the same object', () => {
    const e = emptyEdits();
    expect(unmaskPiece(tracksDoc, e, 'zz')).toBe(e);
  });
});
