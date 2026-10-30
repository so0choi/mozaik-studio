import { describe, expect, it } from 'vitest';
import { isRequired, requiredItems } from './reviewRequired';
import type { ReviewItem, ReviewType } from './types';

const item = (id: string, type: ReviewType, trackIds: string[]): ReviewItem => ({ id, type, trackIds, startFrame: 1, endFrame: 5, box: [1, 1, 2, 2] });
const ed = (visible: string[], reviewed: string[] = []) => ({ visible, reviewed });
const crossing = item('r', 'crossing', ['t1', 't2']);

describe('isRequired', () => {
  it('crossing with both masked is not required', () => expect(isRequired(crossing, ed([]))).toBe(false));
  it('crossing with both visible is not required', () => expect(isRequired(crossing, ed(['t1', 't2']))).toBe(false));
  it('crossing with t1 visible, t2 masked is required (either direction)', () => {
    expect(isRequired(crossing, ed(['t1']))).toBe(true);
    expect(isRequired(crossing, ed(['t2']))).toBe(true);
  });
  it('gap on a visible track is not required; on a masked track it is', () => {
    expect(isRequired(item('g', 'gap', ['t1']), ed(['t1']))).toBe(false);
    expect(isRequired(item('g', 'gap', ['t1']), ed([]))).toBe(true);
  });
  it('low_confidence follows the same rule as gap', () => {
    expect(isRequired(item('l', 'low_confidence', ['t3']), ed(['t3']))).toBe(false);
    expect(isRequired(item('l', 'low_confidence', ['t3']), ed([]))).toBe(true);
  });
  it('split pieces: t2a visible with t1 masked makes the crossing required', () => {
    expect(isRequired(crossing, ed(['t2a']))).toBe(true);
  });
  it('split pieces: t1, t2a, t2b all visible -> not required', () => {
    expect(isRequired(crossing, ed(['t1', 't2a', 't2b']))).toBe(false);
  });
  it('a half-visible split track is still masked for gap items; both halves visible is not', () => {
    expect(isRequired(item('g', 'gap', ['t2']), ed(['t2a']))).toBe(true);
    expect(isRequired(item('g', 'gap', ['t2']), ed(['t2a', 't2b']))).toBe(false);
  });
  it('reviewed items are never required', () => {
    expect(isRequired(item('g', 'gap', ['t1']), ed([], ['g']))).toBe(false);
  });
  it('requiredItems filters', () => {
    const items = [crossing, item('g', 'gap', ['t1'])];
    expect(requiredItems(items, ed([])).map((i) => i.id)).toEqual(['g']);
  });
});
