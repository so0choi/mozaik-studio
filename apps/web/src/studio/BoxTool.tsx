import { useEffect, useRef, useState } from 'react';
import { clampBox, fromDisplay, toDisplay, type Rect } from '../lib/geometry';
import type { Box } from '../lib/types';

interface Props {
  /** content rect of the video inside the overlay, in overlay pixels */
  rect: Rect;
  srcW: number;
  srcH: number;
  /** box in source pixels to start from (review item box), or null */
  initial: Box | null;
  confirmLabel?: string;
  onConfirm: (box: Box) => void;
  onCancel: () => void;
}

/** Drag-to-draw overlay for manual boxes. All boxes are in source-video pixels. */
export function BoxTool({ rect, srcW, srcH, initial, confirmLabel = '이 영역으로 추적', onConfirm, onCancel }: Props) {
  const [box, setBox] = useState<Box | null>(initial);
  const root = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => setBox(initial), [initial]);

  const toSrc = (clientX: number, clientY: number) => {
    const r = root.current!.getBoundingClientRect();
    const [x, y] = fromDisplay([clientX - r.left - rect.x, clientY - r.top - rect.y, 0, 0], srcW, srcH, rect.w, rect.h);
    return { x: Math.max(0, Math.min(srcW, x)), y: Math.max(0, Math.min(srcH, y)) };
  };

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.bt-actions')) return;
    start.current = toSrc(e.clientX, e.clientY);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const p = toSrc(e.clientX, e.clientY);
    setBox([Math.min(s.x, p.x), Math.min(s.y, p.y), Math.abs(p.x - s.x), Math.abs(p.y - s.y)]);
  };
  const onUp = () => {
    start.current = null;
    setBox((b) => (b && (b[2] < 4 || b[3] < 4) ? initial : b));
  };

  const disp = box ? toDisplay(box, srcW, srcH, rect.w, rect.h) : null;
  return (
    <div
      ref={root}
      className="boxtool"
      data-testid="boxtool"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {disp && (
        <div
          className="rb"
          data-testid="boxtool-rect"
          style={{ left: rect.x + disp[0], top: rect.y + disp[1], width: disp[2], height: disp[3] }}
        />
      )}
      <div className="bt-actions" role="group" aria-label="수동 박스">
        <span>드래그해 가릴 영역을 그리세요</span>
        <button type="button" className="go" disabled={!box} onClick={() => box && onConfirm(clampBox(box, srcW, srcH))}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </div>
  );
}
