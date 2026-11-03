import { useRef, type MouseEvent } from 'react';
import { regionAt } from '../lib/hitTest';
import type { Rect } from '../lib/geometry';
import type { Region } from '../lib/types';

interface Props {
  rect: Rect;
  srcW: number;
  srcH: number;
  regions: Region[] | undefined;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onUnmask: (id: string) => void;
}

const X_SIZE = 22;

/** Click a masked area to select it; the X on its corner unmasks just that piece. */
export function MaskPicker({ rect, srcW, srcH, regions, selectedId, onSelect, onUnmask }: Props) {
  const layer = useRef<HTMLDivElement>(null);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const b = layer.current?.getBoundingClientRect();
    const w = b && b.width > 0 ? b.width : rect.w;
    const h = b && b.height > 0 ? b.height : rect.h;
    if (!w || !h) return;
    const x = ((e.clientX - (b?.left ?? 0)) / w) * srcW;
    const y = ((e.clientY - (b?.top ?? 0)) / h) * srcH;
    onSelect(regionAt(regions, x, y)?.id ?? null);
  };

  const sel = selectedId ? regions?.find((r) => r.id === selectedId) : undefined;
  let outline: { left: number; top: number; width: number; height: number } | null = null;
  let xPos = { left: 0, top: 0 };
  if (sel) {
    const sx = rect.w / srcW;
    const sy = rect.h / srcH;
    outline = { left: sel.box[0] * sx, top: sel.box[1] * sy, width: sel.box[2] * sx, height: sel.box[3] * sy };
    const half = X_SIZE / 2;
    xPos = {
      left: Math.min(Math.max(outline.left + outline.width - half, 0), Math.max(rect.w - X_SIZE, 0)),
      top: Math.min(Math.max(outline.top - half, 0), Math.max(rect.h - X_SIZE, 0)),
    };
  }

  return (
    <div
      ref={layer}
      className="maskpicker"
      data-testid="maskpicker"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onClick={onClick}
    >
      {sel && outline && (
        <>
          <div className="mp-outline" data-testid="mask-outline" style={outline} />
          <button
            type="button"
            className="mp-x"
            data-testid="unmask-x"
            aria-label="가림 해제"
            title="가림 해제"
            style={xPos}
            onClick={(e) => {
              e.stopPropagation();
              onUnmask(sel.id);
            }}
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}
