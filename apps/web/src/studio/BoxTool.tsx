import { useEffect, useMemo, useRef, useState } from 'react';
import { clampBox, fromDisplay, toDisplay, type Rect } from '../lib/geometry';
import { clampVertex, dedupeVertices, polygonArea, type Vertex } from '../lib/polygon';
import type { Box, Shape } from '../lib/types';

interface Props {
  /** content rect of the video inside the overlay, in overlay pixels */
  rect: Rect;
  srcW: number;
  srcH: number;
  shape: Shape;
  /** box in source pixels to start from (review item box / redraw), or null. For a new polygon it is only a guide. */
  initial: Box | null;
  /** polygon redraw: existing vertices (0..1 in the box). Kept as-is; only the box changes. */
  initialPoints?: [number, number][] | null;
  confirmLabel?: string;
  onConfirm: (box: Box, points: [number, number][] | null) => void;
  onCancel: () => void;
}

const MIN_BOX = 4;
const CLOSE_PX = 8;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** What stops a polygon from being confirmed, or null when it is valid. */
function polygonProblem(raw: Vertex[]): string | null {
  if (raw.length < 3) return '꼭짓점을 3개 이상 찍으세요';
  const pts = dedupeVertices(raw);
  if (pts.length < 3) return '서로 다른 꼭짓점이 3개 이상 필요합니다';
  if (polygonArea(pts) === 0) return '꼭짓점이 일직선이라 영역이 없습니다';
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  if (Math.max(...xs) - Math.min(...xs) < MIN_BOX || Math.max(...ys) - Math.min(...ys) < MIN_BOX) {
    return '영역이 너무 작습니다 (가로·세로 4px 이상)';
  }
  return null;
}

/** Drag-to-draw (rect, ellipse) / click-to-place (polygon) overlay for manual regions. All coordinates are source-video pixels. */
export function BoxTool({
  rect,
  srcW,
  srcH,
  shape,
  initial,
  initialPoints = null,
  confirmLabel = '이 영역으로 추적',
  onConfirm,
  onCancel,
}: Props) {
  const polyDraw = shape === 'polygon' && !initialPoints;
  const [box, setBox] = useState<Box | null>(polyDraw ? null : initial);
  const [verts, setVerts] = useState<Vertex[]>([]);
  const [closed, setClosed] = useState(false);
  const [cursor, setCursor] = useState<Vertex | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  /** a real double-click is click(1) click(2) dblclick: click(1) added a vertex that dblclick must take back */
  const dbl = useRef({ added: false, pending: false });

  useEffect(() => setBox(polyDraw ? null : initial), [initial, polyDraw]);

  const toSrc = (clientX: number, clientY: number) => {
    const r = root.current!.getBoundingClientRect();
    const [x, y] = fromDisplay([clientX - r.left - rect.x, clientY - r.top - rect.y, 0, 0], srcW, srcH, rect.w, rect.h);
    return { x: Math.max(0, Math.min(srcW, x)), y: Math.max(0, Math.min(srcH, y)) };
  };

  const restoreFocus = () => document.querySelector<HTMLElement>(`[data-draw-tool="${shape}"]`)?.focus();
  const cancel = () => {
    onCancel();
    restoreFocus();
  };

  const problem = polyDraw ? polygonProblem(verts) : null;
  const confirmPolygon = () => {
    if (!polyDraw || polygonProblem(verts)) return;
    const pts = dedupeVertices(verts);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    // outward bounding box (floor the min, ceil the max) clamped to the frame: no vertex is pulled inward
    const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(Math.min(...xs))));
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(Math.min(...ys))));
    const x1 = Math.min(srcW, Math.max(x0 + 1, Math.ceil(Math.max(...xs))));
    const y1 = Math.min(srcH, Math.max(y0 + 1, Math.ceil(Math.max(...ys))));
    const b: [number, number, number, number] = [x0, y0, x1 - x0, y1 - y0];
    const norm = pts.map(
      ([x, y]) =>
        [round4(Math.max(0, Math.min(1, (x - b[0]) / b[2]))), round4(Math.max(0, Math.min(1, (y - b[1]) / b[3])))] as [number, number],
    );
    onConfirm(b, norm);
    restoreFocus();
  };
  const confirmDrag = () => {
    if (!box) return;
    onConfirm(clampBox(box, srcW, srcH), shape === 'polygon' ? initialPoints : null);
    restoreFocus();
  };
  const confirm = () => (polyDraw ? confirmPolygon() : confirmDrag());

  const latest = useRef({ confirm, cancel });
  latest.current = { confirm, cancel };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select')) return;
      if (e.key === 'Escape') {
        latest.current.cancel();
      } else if (e.key === 'Enter' && !t?.closest?.('button')) {
        latest.current.confirm();
        e.preventDefault();
      } else if (e.key === 'Backspace' && polyDraw) {
        setVerts((v) => v.slice(0, -1));
        setClosed(false);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [polyDraw]);

  const inActions = (e: React.SyntheticEvent) => !!(e.target as HTMLElement).closest('.bt-actions');

  const onDown = (e: React.PointerEvent) => {
    if (polyDraw || inActions(e)) return;
    start.current = toSrc(e.clientX, e.clientY);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e: React.PointerEvent) => {
    if (polyDraw) {
      if (!closed) {
        const p = toSrc(e.clientX, e.clientY);
        setCursor([p.x, p.y]);
      }
      return;
    }
    const s = start.current;
    if (!s) return;
    const p = toSrc(e.clientX, e.clientY);
    setBox([Math.min(s.x, p.x), Math.min(s.y, p.y), Math.abs(p.x - s.x), Math.abs(p.y - s.y)]);
  };
  const onUp = () => {
    if (polyDraw) return;
    start.current = null;
    setBox((b) => (b && (b[2] < MIN_BOX || b[3] < MIN_BOX) ? initial : b));
  };
  const onClick = (e: React.MouseEvent) => {
    if (!polyDraw || closed || inActions(e)) return;
    if (e.detail >= 2) {
      dbl.current.pending = true;
      return;
    }
    dbl.current = { added: false, pending: false };
    const p = toSrc(e.clientX, e.clientY);
    if (verts.length >= 3) {
      const k = srcW / rect.w;
      if (Math.hypot(p.x - verts[0][0], p.y - verts[0][1]) <= CLOSE_PX * k) {
        setClosed(true);
        return;
      }
    }
    dbl.current.added = true;
    setVerts((v) => [...v, clampVertex([Math.round(p.x), Math.round(p.y)], srcW, srcH)]);
  };
  const onDouble = (e: React.MouseEvent) => {
    if (!polyDraw || inActions(e)) return;
    const undo = dbl.current.pending && dbl.current.added;
    dbl.current = { added: false, pending: false };
    const remaining = undo ? verts.length - 1 : verts.length;
    if (undo) setVerts((v) => v.slice(0, -1));
    if (remaining >= 3) setClosed(true);
    e.preventDefault();
  };

  // ---- preview geometry (overlay pixels) ----
  const disp = box ? toDisplay(box, srcW, srcH, rect.w, rect.h) : null;
  const guide = polyDraw && initial ? toDisplay(initial, srcW, srcH, rect.w, rect.h) : null;
  const dp = (p: Vertex): [number, number] => {
    const [x, y] = toDisplay([p[0], p[1], 0, 0], srcW, srcH, rect.w, rect.h);
    return [rect.x + x, rect.y + y];
  };
  const polyPoints = useMemo(() => {
    if (polyDraw) {
      return verts.map((p): [number, number] => {
        const [x, y] = toDisplay([p[0], p[1], 0, 0], srcW, srcH, rect.w, rect.h);
        return [rect.x + x, rect.y + y];
      });
    }
    if (shape === 'polygon' && initialPoints && box) {
      const d = toDisplay(box, srcW, srcH, rect.w, rect.h);
      return initialPoints.map(([u, v]): [number, number] => [rect.x + d[0] + u * d[2], rect.y + d[1] + v * d[3]]);
    }
    return [];
  }, [polyDraw, verts, shape, initialPoints, box, srcW, srcH, rect.x, rect.y, rect.w, rect.h]);
  const pstr = (pts: [number, number][]) => pts.map((p) => p.join(',')).join(' ');

  let message: string;
  if (polyDraw) {
    message = `꼭짓점 ${verts.length}개 · ${
      problem ?? (closed ? '도형이 닫혔습니다. Enter로 확정, Backspace로 점 삭제' : '클릭해 꼭짓점 추가 · Enter 또는 첫 점 클릭으로 닫기 · Backspace 되돌리기 · Esc 취소')
    }`;
  } else if (shape === 'polygon') {
    message = '위치·크기만 다시 그립니다. 드래그해 새 영역을 지정하세요';
  } else if (shape === 'ellipse') {
    message = '드래그해 가릴 영역을 그리세요';
  } else {
    message = '드래그해 가릴 영역을 그리세요';
  }
  const canConfirm = polyDraw ? !problem : !!box;

  return (
    <div
      ref={root}
      className="boxtool"
      data-testid="boxtool"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onClick={onClick}
      onDoubleClick={onDouble}
    >
      {shape === 'rect' && disp && (
        <div
          className="rb"
          data-testid="boxtool-rect"
          style={{ left: rect.x + disp[0], top: rect.y + disp[1], width: disp[2], height: disp[3] }}
        />
      )}
      {guide && (
        <div
          className="rb guide"
          data-testid="boxtool-guide"
          style={{ left: rect.x + guide[0], top: rect.y + guide[1], width: guide[2], height: guide[3] }}
        />
      )}
      {shape !== 'rect' && (
        <svg className="bt-svg" aria-hidden="true">
          {shape === 'ellipse' && disp && (
            <ellipse
              data-testid="boxtool-shape"
              cx={rect.x + disp[0] + disp[2] / 2}
              cy={rect.y + disp[1] + disp[3] / 2}
              rx={disp[2] / 2}
              ry={disp[3] / 2}
            />
          )}
          {shape === 'polygon' && polyPoints.length >= 3 && (
            <polygon
              data-testid="boxtool-shape"
              data-closed={polyDraw ? String(closed) : 'true'}
              fillRule="evenodd"
              points={pstr(polyPoints)}
            />
          )}
          {polyDraw && polyPoints.length >= 1 && polyPoints.length < 3 && (
            <polyline className="open" points={pstr(polyPoints)} />
          )}
          {polyDraw && polyPoints.length >= 3 && !closed && <polyline className="open" points={pstr(polyPoints)} />}
          {polyDraw && !closed && cursor && polyPoints.length >= 1 && (
            <line
              className="open rubber"
              x1={polyPoints[polyPoints.length - 1][0]}
              y1={polyPoints[polyPoints.length - 1][1]}
              x2={dp(cursor)[0]}
              y2={dp(cursor)[1]}
            />
          )}
          {polyDraw &&
            polyPoints.map((p, i) => <circle key={i} className="vtx" cx={p[0]} cy={p[1]} r={i === 0 ? 6 : 4} />)}
        </svg>
      )}
      <div className="bt-actions" role="group" aria-label="수동 영역">
        <span role="status">{message}</span>
        <button type="button" className="go" disabled={!canConfirm} onClick={confirm}>
          {confirmLabel}
        </button>
        <button type="button" onClick={cancel}>
          취소
        </button>
      </div>
    </div>
  );
}
