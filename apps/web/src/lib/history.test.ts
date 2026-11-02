import { describe, expect, it } from 'vitest';
import { HISTORY_CAP, emptyHistory, push, redo, undo } from './history';
import { emptyEdits } from './edits';
import type { Edits } from './types';

const ed = (visible: string[], extra: Partial<Edits> = {}): Edits => ({ ...emptyEdits(), visible, ...extra });
const m = (id: string, deleted = false) => ({ id, anchors: [{ frame: 1, box: [0, 0, 5, 5] as [number, number, number, number] }], trim: null, deleted });

describe('history', () => {
  it('undo/redo on empty stacks returns null', () => {
    expect(undo(emptyHistory(), ed([]))).toBeNull();
    expect(redo(emptyHistory(), ed([]))).toBeNull();
  });

  it('push -> undo -> redo round-trips', () => {
    const a = ed([]);
    const b = ed(['t1']);
    const h = push(emptyHistory(), a);
    const u = undo(h, b)!;
    expect(u.edits).toEqual(a);
    expect(u.history.past).toEqual([]);
    expect(u.history.future).toEqual([b]);
    const r = redo(u.history, a)!;
    expect(r.edits).toEqual(b);
    expect(r.history.past).toEqual([a]);
    expect(r.history.future).toEqual([]);
  });

  it('a new push clears the redo stack', () => {
    const h0 = push(emptyHistory(), ed([]));
    const u = undo(h0, ed(['t1']))!;
    expect(u.history.future.length).toBe(1);
    expect(push(u.history, ed([])).future).toEqual([]);
  });

  it('caps the past at 100 entries, dropping the oldest', () => {
    let h = emptyHistory();
    for (let i = 0; i < HISTORY_CAP + 20; i++) h = push(h, ed([`t${i}`]));
    expect(h.past.length).toBe(HISTORY_CAP);
    expect(h.past[0].visible).toEqual(['t20']);
    expect(h.past[HISTORY_CAP - 1].visible).toEqual([`t${HISTORY_CAP + 19}`]);
  });

  it('undo keeps a manual entry missing from the snapshot, as deleted:true', () => {
    const before = ed([]);
    const after = ed([], { manual: [m('m1')] });
    const u = undo(push(emptyHistory(), before), after)!;
    expect(u.edits.manual).toEqual([{ ...m('m1'), deleted: true }]);
    // redo restores the live entry
    const r = redo(u.history, u.edits)!;
    expect(r.edits.manual).toEqual([m('m1')]);
  });

  it('redo keeps a manual entry missing from the target, as deleted:true', () => {
    const withM = ed([], { manual: [m('m1')] });
    const without = ed([]);
    // state: current has m1, future snapshot lacks it
    const r = redo({ past: [], future: [without] }, withM)!;
    expect(r.edits.manual).toEqual([{ ...m('m1'), deleted: true }]);
  });

  it('does not duplicate manual entries present in both', () => {
    const a = ed([], { manual: [m('m1')] });
    const b = ed(['t1'], { manual: [m('m1')] });
    expect(undo(push(emptyHistory(), a), b)!.edits.manual).toEqual([m('m1')]);
  });
});
