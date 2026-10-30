/** Frame index shown at a given media time. Same rule as the worker: round(t * fps). */
export function frameAt(mediaTime: number, fps: number): number {
  return Math.round(mediaTime * fps);
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
