import { describe, expect, it } from 'vitest';
import { debugBoxesAt, debugFrameText } from './debugBoxes';
import type { Track, TracksDoc } from './types';

const tr = (id: string, over: Partial<Track> = {}): Track => ({
  id, thumb: '', samples: [], blockSize: 8, segments: [], frames: { '5': [1, 2, 3, 4] }, ...over,
});
const doc = (tracks: Track[]): TracksDoc => ({ version: 1, fps: 30, width: 100, height: 100, frameCount: 100, tracks });
const ed = (visible: string[], manual: { id: string; deleted: boolean }[] = []) =>
  ({ visible, manual: manual.map((m) => ({ ...m, anchors: [], trim: null })) });

describe('debugBoxesAt', () => {
  it('detected / held / suspect kinds and labels', () => {
    const t = doc([
      tr('t1', { scores: { '5': 0.824 } }),
      tr('t2'),
      tr('t3', { suspect: true, scores: { '5': 0.41 } }),
      tr('t4', { nonface: true }),
    ]);
    const r = debugBoxesAt(5, t, ed(['t1']), []);
    expect(r.map((b) => [b.id, b.kind, b.label])).toEqual([
      ['t1', 'detected', 't1 0.82 · 보임'],
      ['t2', 'held', 't2 유지 · 가림'],
      ['t3', 'suspect', 't3 0.41 의심 · 가림'],
      ['t4', 'suspect', 't4 유지 의심 · 가림'],
    ]);
    expect(r[0].score).toBe(0.824);
    expect(r[1].score).toBeNull();
  });

  it('split state rule', () => {
    const t = doc([tr('t2'), tr('t3'), tr('t4')]);
    const r = debugBoxesAt(5, t, ed(['t2a', 't3a', 't3b']), []);
    expect(r.map((b) => b.state)).toEqual(['일부 보임', '보임', '가림']);
  });

  it('skips frames without a box; manual boxes after tracks, deleted skipped', () => {
    const t = doc([tr('t1', { frames: { '9': [0, 0, 1, 1] } }), tr('t2')]);
    const manual = [
      { id: 'm1', frames: { '5': [5, 5, 5, 5] as [number, number, number, number] }, segments: [] as [number, number][] },
      { id: 'm2', frames: { '5': [6, 6, 6, 6] as [number, number, number, number] }, segments: [] as [number, number][] },
    ];
    const r = debugBoxesAt(5, t, ed([], [{ id: 'm2', deleted: true }]), manual);
    expect(r.map((b) => b.id)).toEqual(['t2', 'm1']);
    expect(r[1]).toMatchObject({ kind: 'manual', score: null, state: null, label: 'm1' });
  });
});

describe('debugFrameText', () => {
  it('formats header and lines', () => {
    const t = doc([tr('t12', { scores: { '5': 0.82 } }), tr('t40')]);
    const b = debugBoxesAt(5, t, ed(['t40']), [
      { id: 'm1', frames: { '5': [9, 8, 7, 6] }, segments: [] },
    ]);
    expect(debugFrameText('j1', 2471, 24, b)).toBe(
      ['작업 j1 · 프레임 2471 · 01:42.96', 't12 detected 0.82 가림 [1,2,3,4]', 't40 held - 보임 [1,2,3,4]', 'm1 manual - - [9,8,7,6]'].join('\n'),
    );
  });
  it('says 박스 없음 when empty', () => {
    expect(debugFrameText('j1', 0, 30, [])).toBe('작업 j1 · 프레임 0 · 00:00.00\n박스 없음');
  });
});
