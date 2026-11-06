import { memo, useEffect, useState, type RefObject } from 'react';
import { formatTime } from '../lib/frames';

const SPEEDS = [0.5, 1, 1.5, 2];
const nextSpeed = (s: number) => SPEEDS[(Math.max(0, SPEEDS.indexOf(s)) + 1) % SPEEDS.length];

interface Props {
  videoRef: RefObject<HTMLVideoElement>;
  fps: number;
  frame: number;
  frameCount: number;
  onTogglePlay: () => void;
  /** absolute seek to a frame (clamped by the caller) */
  onSeek: (frame: number) => void;
  /** step the playhead by whole frames (pauses first) */
  onStep: (delta: number) => void;
  /** preview-only detection-box debug overlay */
  debug?: boolean;
  onToggleDebug?: () => void;
  masksOff?: boolean;
  onToggleMasks?: () => void;
  onCopyFrame?: () => void;
  /** transient label for the copy button (e.g. 복사됨) */
  copyLabel?: string;
}

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
);

function PlayerControlsInner(p: Props) {
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);

  useEffect(() => {
    const v = p.videoRef.current;
    if (!v) return;
    const on = () => setPlaying(true);
    const off = () => setPlaying(false);
    v.addEventListener('play', on);
    v.addEventListener('pause', off);
    v.addEventListener('ended', off);
    return () => {
      v.removeEventListener('play', on);
      v.removeEventListener('pause', off);
      v.removeEventListener('ended', off);
    };
  }, [p.videoRef]);

  const toggleMute = () => {
    const v = p.videoRef.current;
    const m = !muted;
    if (v) v.muted = m;
    setMuted(m);
  };
  const cycleSpeed = () => {
    const v = p.videoRef.current;
    const s = nextSpeed(speed);
    if (v) v.playbackRate = s;
    setSpeed(s);
  };
  const jump = Math.round(5 * p.fps);

  return (
    <div className="pbar" role="group" aria-label="재생 컨트롤">
      <div className="pb-left">
        <button type="button" className="ic" aria-label="5초 뒤로" onClick={() => p.onSeek(p.frame - jump)}>
          <Icon d="M8 3v3L3.5 3.5 8 1v2a6 6 0 11-6 6h1.6A4.4 4.4 0 108 3z" />
        </button>
        <button type="button" className="play" onClick={p.onTogglePlay} aria-label={playing ? '일시정지' : '재생'}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {playing ? <path d="M3.5 2h3v12h-3zM9.5 2h3v12h-3z" /> : <path d="M4 2.5v11l9-5.5z" />}
          </svg>
        </button>
        <button type="button" className="ic" aria-label="5초 앞으로" onClick={() => p.onSeek(p.frame + jump)}>
          <Icon d="M8 3v3l4.5-2.5L8 1v2a6 6 0 106 6h-1.6A4.4 4.4 0 118 3z" />
        </button>
        <button type="button" className="ic" aria-label="1프레임 뒤로" onClick={() => p.onStep(-1)}>
          <Icon d="M3 2h2v12H3zM13 2.5v11L6 8z" />
        </button>
        <button type="button" className="ic" aria-label="1프레임 앞으로" onClick={() => p.onStep(1)}>
          <Icon d="M11 2h2v12h-2zM3 2.5v11L10 8z" />
        </button>
        <div className="time" data-testid="time">
          {formatTime(p.frame / p.fps)} <span>/ {formatTime(p.frameCount / p.fps)}</span>
        </div>
      </div>
      <div className="pb-right">
        {p.onToggleDebug && (
          <>
            <button type="button" className="dbg" aria-pressed={!!p.debug} title="검출 박스 보기 (D)" onClick={p.onToggleDebug}>
              검출 박스
            </button>
            {p.debug && (
              <>
                <button
                  type="button"
                  className="dbg"
                  aria-pressed={!!p.masksOff}
                  title="미리보기에서만 모자이크를 끕니다. 결과 영상에는 영향 없음"
                  onClick={p.onToggleMasks}
                >
                  모자이크 끄기
                </button>
                <button type="button" className="dbg" onClick={p.onCopyFrame}>
                  {p.copyLabel ?? '프레임 정보 복사'}
                </button>
              </>
            )}
          </>
        )}
        <button
          type="button"
          className="ic"
          aria-label={muted ? '음소거 해제' : '음소거'}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 6h2.5L8 3v10L4.5 10H2z" />
            {muted ? <path d="M10 6l4 4M14 6l-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" /> : <path d="M10.5 5.5a3.5 3.5 0 010 5" stroke="currentColor" strokeWidth="1.5" fill="none" />}
          </svg>
        </button>
        <button type="button" className="spd" aria-label={`재생 속도 ${speed}배`} onClick={cycleSpeed}>
          {speed}x
        </button>
      </div>
    </div>
  );
}

export const PlayerControls = memo(PlayerControlsInner);
