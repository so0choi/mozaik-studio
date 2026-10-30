import { describe, expect, it } from 'vitest';
import { people } from './people';
import { groupPersons, setPersonVisible, splitTrack, renameGroup, emptyEdits } from './edits';
import { tracksDoc, edits } from './fixtures';
import type { TracksDoc } from './types';

describe('people', () => {
  it('returns [] when there are no tracks', () => {
    const empty: TracksDoc = { ...tracksDoc, tracks: [] };
    expect(people(empty, emptyEdits())).toEqual([]);
  });

  it('splits t2 into t2a/t2b persons using fixture edits', () => {
    const ps = people(tracksDoc, edits);
    expect(ps.map((p) => p.key)).toEqual(['t1', 't2a', 't2b', 't3']);
    const byKey = Object.fromEntries(ps.map((p) => [p.key, p]));
    expect(byKey.t1.visible).toBe(true);
    expect(byKey.t2a.visible).toBe(false);
    expect(byKey.t2b.visible).toBe(true);
    expect(byKey.t3.visible).toBe(false);
    expect(byKey.t3.label).toBe('인물 3');
    expect(byKey.t1.appearSec).toBeCloseTo(3);
    expect(byKey.t2a.appearSec).toBeCloseTo(45 / 30);
    expect(byKey.t3.thumb).toBe('thumbs/t3.jpg');
    expect(byKey.t3.fragmentCount).toBe(1);
  });

  it('default is hidden', () => {
    expect(people(tracksDoc, emptyEdits()).every((p) => !p.visible)).toBe(true);
  });
});

describe('edit operations', () => {
  it('setPersonVisible toggles all of a person\'s tracks', () => {
    let e = groupPersons(tracksDoc, emptyEdits(), ['t1', 't3']);
    const g = people(tracksDoc, e).find((p) => p.key === 'g1')!;
    e = setPersonVisible(e, g, true);
    expect(e.visible.sort()).toEqual(['t1', 't3']);
    expect(people(tracksDoc, e).find((p) => p.key === 'g1')!.visible).toBe(true);
    e = setPersonVisible(e, people(tracksDoc, e).find((p) => p.key === 'g1')!, false);
    expect(e.visible).toEqual([]);
  });

  it('groupPersons creates g<n> with union of trackIds and hides unless all were visible', () => {
    const base = { ...emptyEdits(), visible: ['t1'] };
    const e = groupPersons(tracksDoc, base, ['t1', 't3']);
    expect(e.groups).toEqual([{ id: 'g1', trackIds: ['t1', 't3'] }]);
    expect(e.visible).toEqual([]);
    const e2 = groupPersons(tracksDoc, { ...emptyEdits(), visible: ['t1', 't3'] }, ['t1', 't3']);
    expect(e2.visible.sort()).toEqual(['t1', 't3']);
    const ps = people(tracksDoc, e);
    expect(ps.map((p) => p.key)).toEqual(['g1', 't2']);
    expect(ps[0].fragmentCount).toBe(2);
  });

  it('second group gets next id and merging a group dissolves it', () => {
    let e = groupPersons(tracksDoc, emptyEdits(), ['t1', 't2']);
    e = groupPersons(tracksDoc, e, ['g1', 't3']);
    expect(e.groups.length).toBe(1);
    expect(e.groups[0].id).toBe('g2');
    expect(e.groups[0].trackIds.sort()).toEqual(['t1', 't2', 't3']);
  });

  it('renameGroup creates a single-track group when needed and clears on empty', () => {
    let e = renameGroup(tracksDoc, emptyEdits(), people(tracksDoc, emptyEdits())[0], '진행자');
    expect(e.groups).toEqual([{ id: 'g1', trackIds: ['t1'], label: '진행자' }]);
    expect(people(tracksDoc, e)[0].label).toBe('진행자');
    e = renameGroup(tracksDoc, e, people(tracksDoc, e)[0], '  ');
    expect(people(tracksDoc, e)[0].label).toBe('인물 1');
  });

  it('splitTrack adds a split, carries visibility to both pieces, shows two cards', () => {
    const e0 = { ...emptyEdits(), visible: ['t1'] };
    const e = splitTrack(e0, 't1', 40);
    expect(e.splits).toEqual([{ trackId: 't1', frame: 40 }]);
    expect(e.visible.sort()).toEqual(['t1a', 't1b']);
    expect(people(tracksDoc, e).map((p) => p.key)).toEqual(['t1a', 't1b', 't2', 't3']);
  });

  it('splitTrack of a single-track group keeps label on piece a only', () => {
    let e = renameGroup(tracksDoc, emptyEdits(), people(tracksDoc, emptyEdits())[0], '진행자');
    e = splitTrack(e, 't1', 40);
    const ps = people(tracksDoc, e);
    expect(ps.map((p) => [p.key, p.label])).toEqual([['g1', '진행자'], ['t1b', '인물 1b'], ['t2', '인물 2'], ['t3', '인물 3']]);
  });
});

describe('people suspect', () => {
  const withSuspect = (ids: string[]): TracksDoc => ({
    ...tracksDoc,
    tracks: tracksDoc.tracks.map((t) => (ids.includes(t.id) ? { ...t, suspect: true } : t)),
  });

  it('absent field -> suspect false', () => {
    expect(people(tracksDoc, emptyEdits()).every((p) => p.suspect === false)).toBe(true);
  });

  it('orders suspects last, keeping relative order', () => {
    const ps = people(withSuspect(['t1']), emptyEdits());
    expect(ps.map((p) => p.key)).toEqual(['t2', 't3', 't1']);
    expect(ps.map((p) => p.suspect)).toEqual([false, false, true]);
  });

  it('group is suspect only if every piece is suspect', () => {
    const e = groupPersons(tracksDoc, emptyEdits(), ['t1', 't3']);
    const mixed = people(withSuspect(['t1']), e).find((p) => p.key === 'g1')!;
    expect(mixed.suspect).toBe(false);
    const all = people(withSuspect(['t1', 't3']), e).find((p) => p.key === 'g1')!;
    expect(all.suspect).toBe(true);
  });
});
