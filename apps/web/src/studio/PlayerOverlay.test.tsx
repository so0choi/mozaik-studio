import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlayerOverlay } from './PlayerOverlay';

const base = {
  src: '/v.mp4', srcW: 640, srcH: 360, fps: 30, frameCount: 90, frame: 0,
  regions: new Map(), background: null, highlight: null, focusBoxes: () => [],
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

describe('PlayerOverlay debug boxes', () => {
  const makeCtx = () => {
    const calls: Record<string, unknown[][]> = {};
    return new Proxy({ calls } as Record<string, unknown>, {
      get(t, k: string) {
        if (k === 'calls') return calls;
        if (k === 'measureText') return () => ({ width: 30 });
        if (k in t) return t[k];
        return (...a: unknown[]) => { (calls[k] ||= []).push(a); };
      },
      set(t, k: string, v) { t[k] = v; return true; },
    }) as unknown as CanvasRenderingContext2D & { calls: Record<string, unknown[][]> };
  };

  it('strokes each debug box and draws labels + frame tag; raw video when masksOff', () => {
    const ctx = makeCtx();
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    const debugBoxes = vi.fn(() => [
      { id: 't1', kind: 'detected' as const, box: [10, 10, 50, 50] as [number, number, number, number], score: 0.9, state: '가림' as const, label: 't1 0.90 · 가림' },
      { id: 't2', kind: 'held' as const, box: [100, 100, 50, 50] as [number, number, number, number], score: null, state: '보임' as const, label: 't2 유지 · 보임' },
    ]);
    const ref = createRef<HTMLVideoElement>();
    render(<PlayerOverlay {...base} videoRef={ref as never} onFrame={vi.fn()} debugBoxes={debugBoxes} masksOff />);
    expect(debugBoxes).toHaveBeenCalled();
    expect(ctx.calls.strokeRect.length).toBeGreaterThanOrEqual(2);
    const texts = ctx.calls.fillText.map((a) => a[0]);
    expect(texts).toContain('t1 0.90 · 가림');
    expect(texts).toContain('t2 유지 · 보임');
    expect(texts.some((t) => String(t).startsWith('f 0 · 00:00.00'))).toBe(true);
    spy.mockRestore();
  });

  it('draws no debug text without debugBoxes', () => {
    const ctx = makeCtx();
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    render(<PlayerOverlay {...base} videoRef={createRef<HTMLVideoElement>() as never} onFrame={vi.fn()} />);
    expect(ctx.calls.fillText).toBeUndefined();
    spy.mockRestore();
  });
});
