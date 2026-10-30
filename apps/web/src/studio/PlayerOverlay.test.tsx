import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlayerOverlay } from './PlayerOverlay';

const base = {
  src: '/v.mp4', srcW: 640, srcH: 360, fps: 30, frameCount: 90, frame: 0,
  boxes: new Map(), highlight: null, focusBoxes: () => [],
};

describe('PlayerOverlay frame clock', () => {
  it('uses requestVideoFrameCallback metadata.mediaTime when available', () => {
    const cbs: ((now: number, m: { mediaTime: number }) => void)[] = [];
    (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback = function (cb: never) {
      cbs.push(cb);
      return cbs.length;
    };
    (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback = vi.fn();
    const onFrame = vi.fn();
    const ref = createRef<HTMLVideoElement>();
    render(<PlayerOverlay {...base} videoRef={ref as never} onFrame={onFrame} />);
    cbs[cbs.length - 1](0, { mediaTime: 1.5 });
    expect(onFrame).toHaveBeenCalledWith(45);
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestVideoFrameCallback;
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).cancelVideoFrameCallback;
  });

  it('falls back to seeked/timeupdate with currentTime', () => {
    const onFrame = vi.fn();
    const ref = createRef<HTMLVideoElement>();
    render(<PlayerOverlay {...base} videoRef={ref as never} onFrame={onFrame} />);
    Object.defineProperty(ref.current!, 'currentTime', { configurable: true, value: 2.0 });
    fireEvent(ref.current!, new Event('seeked'));
    expect(onFrame).toHaveBeenCalledWith(60);
    Object.defineProperty(ref.current!, 'currentTime', { configurable: true, value: 2.04 });
    fireEvent(ref.current!, new Event('timeupdate'));
    expect(onFrame).toHaveBeenLastCalledWith(61);
  });
});
