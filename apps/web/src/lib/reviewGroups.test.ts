import { describe, expect, it } from 'vitest';
import type { Edits, ReviewItem } from './types';
import { bulkConfirmable, confirmGroupEdits, groupItems, groupOf } from './reviewGroups';

const it_ = (id: string, startFrame: number, type: ReviewItem['type'] = 'gap'): ReviewItem => ({
  id,
  type,
  trackIds: ['t1'],
  startFrame,
  endFrame: startFrame + 5,
  box: [0, 0, 1, 1],
});
const never = () => false;

describe('groupItems', () => {
  it('returns no groups for empty input', () => {
    expect(groupItems([], 30, never)).toEqual([]);
  });

  it('splits at the window boundary (frame w-1 vs w) with window bounds', () => {
    const g = groupItems([it_('a', 149), it_('b', 150)], 30, never);
    expect(g.map((x) => x.key)).toEqual([0, 1]);
    expect(g[0]).toMatchObject({ startFrame: 0, endFrame: 149 });
    expect(g[1]).toMatchObject({ startFrame: 150, endFrame: 299 });
    expect(g[0].items.map((i) => i.id)).toEqual(['a']);
  });

  it('orders groups by key and puts suspect items last, then by start and id', () => {
    const items = [it_('s', 1), it_('z', 20), it_('b', 10), it_('a', 10), it_('far', 400)];
    const g = groupItems(items, 30, (i) => i.id === 's');
    expect(g.map((x) => x.key)).toEqual([0, 2]);
    expect(g[0].items.map((i) => i.id)).toEqual(['a', 'b', 'z', 's']);
  });
});

describe('bulkConfirmable / groupOf', () => {
  it('excludes crossings only', () => {
    expect(bulkConfirmable(it_('x', 0, 'crossing'))).toBe(false);
    expect(bulkConfirmable(it_('x', 0, 'gap'))).toBe(true);
    expect(bulkConfirmable(it_('x', 0, 'low_confidence'))).toBe(true);
  });

  it('finds the group of an item or null', () => {
    const g = groupItems([it_('a', 0), it_('b', 200)], 30, never);
    expect(groupOf(g, 'b')?.key).toBe(1);
    expect(groupOf(g, 'nope')).toBeNull();
  });
});

describe('confirmGroupEdits', () => {
  it('marks non-crossings reviewed, leaves crossings and visibility alone', () => {
    const edits: Edits = { version: 1, visible: ['t9'], groups: [], splits: [], manual: [], reviewed: ['old'] };
    const [group] = groupItems([it_('a', 0), it_('c', 5, 'crossing'), it_('l', 9, 'low_confidence')], 30, never);
    const out = confirmGroupEdits(edits, group);
    expect(out.reviewed).toEqual(['old', 'a', 'l']);
    expect(out.visible).toBe(edits.visible);
  });
});
