import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Timeline } from './Timeline';
import type { ReviewItem } from '../lib/types';

const item = (id: string, startFrame: number): ReviewItem =>
  ({ id, type: 'gap', trackIds: ['t1'], startFrame, endFrame: startFrame + 5, box: [0, 0, 1, 1] }) as ReviewItem;

function renderTl(onSeek = vi.fn(), onSelectItem = vi.fn()) {
  render(
    <Timeline
      person={null}
      fps={30}
      frameCount={100}
      frame={0}
      unresolved={[item('a', 50)]}
      resolved={[]}
      activeId={null}
      thumbSrc={(p) => p}
      onSeek={onSeek}
      onSelectItem={onSelectItem}
    />,
  );
  return { onSeek, onSelectItem };
}

let orig: typeof HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  orig = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 1000, bottom: 16, width: 1000, height: 16, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});
afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = orig;
});

describe('Timeline scrubbing', () => {
  it('pointer down seeks, pointer move keeps seeking while captured, pointer up stops', () => {
    const { onSeek } = renderTl();
    const area = screen.getByRole('slider').parentElement!;
    fireEvent.pointerDown(area, { clientX: 200, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(20);
    fireEvent.pointerMove(area, { clientX: 700, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(70);
    fireEvent.pointerUp(area, { clientX: 700, pointerId: 1 });
    onSeek.mockClear();
    fireEvent.pointerMove(area, { clientX: 900, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('pointer move without a prior pointer down does nothing', () => {
    const { onSeek } = renderTl();
    fireEvent.pointerMove(screen.getByRole('slider').parentElement!, { clientX: 300 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('clamps outside the bar while dragging', () => {
    const { onSeek } = renderTl();
    const area = screen.getByRole('slider').parentElement!;
    fireEvent.pointerDown(area, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(area, { clientX: 5000, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(100);
    fireEvent.pointerMove(area, { clientX: -50, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });

  it('pointer down on a marker does not scrub', () => {
    const { onSeek } = renderTl();
    fireEvent.pointerDown(screen.getByRole('button', { name: /확인 필요/ }), { clientX: 500, pointerId: 1 });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('markers live in their own lane, so clicking the track at a marker x seeks', () => {
    const { onSeek, onSelectItem } = renderTl();
    const track = screen.getByRole('slider');
    const marker = screen.getByRole('button', { name: /확인 필요/ });
    expect(track.contains(marker)).toBe(false);
    expect(marker.parentElement).not.toBe(track.parentElement);
    fireEvent.click(track, { clientX: 500 });
    expect(onSeek).toHaveBeenLastCalledWith(50);
    expect(onSelectItem).not.toHaveBeenCalled();
    fireEvent.click(marker, { clientX: 500 });
    expect(onSelectItem).toHaveBeenCalledWith('a');
  });

  it('arrow keys still seek ±5s', () => {
    const { onSeek } = renderTl();
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(100); // min(total, 0+150)
  });
});
