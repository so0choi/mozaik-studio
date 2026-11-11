import { memo, useState } from 'react';
import { formatDuration, formatTime } from '../lib/frames';
import type { TracksDoc } from '../lib/types';

interface Props {
  filename: string;
  width: number;
  height: number;
  frameCount: number;
  fps: number;
  timing?: TracksDoc['timing'];
}

const ext = (name: string) => {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toUpperCase() : '-';
};

function VideoInfoInner(p: Props) {
  const [open, setOpen] = useState(true);
  const rows: [string, string][] = [
    ['파일명', p.filename],
    ['해상도', `${p.width}×${p.height}`],
    ['분량', formatTime(p.frameCount / p.fps)],
    ['프레임', `${p.fps}fps`],
    ['타입', ext(p.filename)],
  ];
  if (p.timing) {
    const { normalizeSec, analyzeSec } = p.timing;
    const detect = `검출 ${formatDuration(analyzeSec)}`;
    rows.push([
      '처리 시간',
      normalizeSec == null
        ? detect
        : `${formatDuration(normalizeSec + analyzeSec)} (변환 ${formatDuration(normalizeSec)} · ${detect})`,
    ]);
  }
  return (
    <section className="bcard vinfo" aria-label="비디오 정보">
      <button type="button" className="vi-toggle" aria-expanded={open} aria-controls="vi-body" onClick={() => setOpen(!open)}>
        <span className="h">비디오 정보</span>
        <svg className="chev" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <dl id="vi-body" className="vi-body">
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export const VideoInfo = memo(VideoInfoInner);
