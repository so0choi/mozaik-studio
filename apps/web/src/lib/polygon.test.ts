import { describe, expect, it } from 'vitest';
import { clampVertex, dedupeVertices, polygonArea } from './polygon';

describe('polygon helpers', () => {
  it('polygonArea: collinear 3 points is 0, triangle is half the box', () => {
    expect(polygonArea([[0, 0], [5, 5], [10, 10]])).toBe(0);
    expect(polygonArea([[0, 0], [10, 0], [0, 10]])).toBe(50);
  });

  it('dedupeVertices drops consecutive duplicates, including a closing repeat of the first point', () => {
    expect(dedupeVertices([[1, 1], [1, 1], [4, 1], [4, 1], [4, 5], [1, 1]])).toEqual([[1, 1], [4, 1], [4, 5]]);
    expect(dedupeVertices([[2, 2], [2, 2], [2, 2]])).toEqual([[2, 2]]);
  });

  it('clampVertex pins out-of-frame coordinates to the frame edge', () => {
    expect(clampVertex([-5, 400], 640, 360)).toEqual([0, 360]);
    expect(clampVertex([700, -1], 640, 360)).toEqual([640, 0]);
    expect(clampVertex([10, 20], 640, 360)).toEqual([10, 20]);
  });
});
