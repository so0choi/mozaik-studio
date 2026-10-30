import { describe, expect, it } from 'vitest';
import { addManualAnchor, deleteManual, emptyEdits, setManualTrim } from './edits';
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
