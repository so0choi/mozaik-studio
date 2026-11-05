/**
 * Frame index on screen at a media time. Frame f is shown for t in [f/fps, (f+1)/fps), so this floors;
 * rounding drew the NEXT frame's masks for the second half of every frame (a face exposed on the frame
 * before a cut). The small epsilon absorbs float error when t is exactly a frame's start.
 */
export function frameAt(mediaTime: number, fps: number): number {
  return Math.max(0, Math.floor(mediaTime * fps + 1e-3));
}

/** Media time to seek to for frame f: its middle, so the browser can never land on the previous frame. */
export function timeOfFrame(frame: number, fps: number): number {
  return (frame + 0.5) / fps;
}

export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m ? `${m}분 ` : ''}${r}초`;
}
