import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlayerControls } from './PlayerControls';

function setup(over: Partial<React.ComponentProps<typeof PlayerControls>> = {}) {
  const video = document.createElement('video');
  const ref = createRef<HTMLVideoElement>() as { current: HTMLVideoElement | null };
  ref.current = video;
  const props = { onTogglePlay: vi.fn(), onSeek: vi.fn(), onStep: vi.fn() };
  render(<PlayerControls videoRef={ref as never} fps={30} frame={150} frameCount={240} {...props} {...over} />);
  return { video, ...props };
}

describe('PlayerControls', () => {
  it('shows time and calls onStep with -1 / +1', () => {
    const { onStep } = setup();
    expect(screen.getByTestId('time')).toHaveTextContent('00:05 / 00:08');
    fireEvent.click(screen.getByRole('button', { name: '1프레임 뒤로' }));
    expect(onStep).toHaveBeenLastCalledWith(-1);
    fireEvent.click(screen.getByRole('button', { name: '1프레임 앞으로' }));
    expect(onStep).toHaveBeenLastCalledWith(1);
  });

  it('5초 buttons seek relative to the current frame; play toggles', () => {
    const { onSeek, onTogglePlay } = setup();
    fireEvent.click(screen.getByRole('button', { name: '5초 뒤로' }));
    expect(onSeek).toHaveBeenLastCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: '5초 앞으로' }));
    expect(onSeek).toHaveBeenLastCalledWith(300);
    fireEvent.click(screen.getByRole('button', { name: '재생' }));
    expect(onTogglePlay).toHaveBeenCalled();
  });

  it('play/pause label follows the video events', () => {
    const { video } = setup();
    fireEvent(video, new Event('play'));
    expect(screen.getByRole('button', { name: '일시정지' })).toBeInTheDocument();
    fireEvent(video, new Event('pause'));
    expect(screen.getByRole('button', { name: '재생' })).toBeInTheDocument();
  });

  it('mute toggles video.muted and speed cycles 1 -> 1.5 -> 2 -> 0.5 -> 1', () => {
    const { video } = setup();
    const mute = screen.getByRole('button', { name: '음소거' });
    fireEvent.click(mute);
    expect(video.muted).toBe(true);
    expect(mute).toHaveAttribute('aria-pressed', 'true');
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole('button', { name: /재생 속도/ }));
      seen.push(video.playbackRate);
    }
    expect(seen).toEqual([1.5, 2, 0.5, 1]);
    expect(screen.getByRole('button', { name: /재생 속도/ })).toHaveTextContent('1x');
  });

  it('debug controls only render when onToggleDebug is given; extras only while debug is on', () => {
    setup();
    expect(screen.queryByRole('button', { name: '검출 박스' })).toBeNull();
  });

  it('검출 박스 toggle shows 모자이크 끄기 / 프레임 정보 복사 only when on', () => {
    const onToggleDebug = vi.fn();
    const onToggleMasks = vi.fn();
    const onCopyFrame = vi.fn();
    const base = { onToggleDebug, onToggleMasks, onCopyFrame };
    const { rerender } = (() => {
      const video = document.createElement('video');
      const ref = { current: video };
      const r = render(<PlayerControls videoRef={ref as never} fps={30} frame={0} frameCount={9} onTogglePlay={vi.fn()} onSeek={vi.fn()} onStep={vi.fn()} {...base} debug={false} />);
      return { rerender: (o: object) => r.rerender(<PlayerControls videoRef={ref as never} fps={30} frame={0} frameCount={9} onTogglePlay={vi.fn()} onSeek={vi.fn()} onStep={vi.fn()} {...base} {...o} />) };
    })();
    const t = screen.getByRole('button', { name: '검출 박스' });
    expect(t).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: '모자이크 끄기' })).toBeNull();
    fireEvent.click(t);
    expect(onToggleDebug).toHaveBeenCalled();
    rerender({ debug: true, masksOff: true });
    expect(screen.getByRole('button', { name: '검출 박스' })).toHaveAttribute('aria-pressed', 'true');
    const m = screen.getByRole('button', { name: '모자이크 끄기' });
    expect(m).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(m);
    expect(onToggleMasks).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '프레임 정보 복사' }));
    expect(onCopyFrame).toHaveBeenCalled();
  });
});
