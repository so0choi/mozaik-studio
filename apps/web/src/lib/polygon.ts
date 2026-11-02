export type Vertex = [number, number];

/** Absolute polygon area (shoelace). 0 for collinear or degenerate input. */
export function polygonArea(points: Vertex[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Remove consecutive duplicate vertices (and a last vertex that repeats the first). */
export function dedupeVertices(points: Vertex[]): Vertex[] {
  const out: Vertex[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  while (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

/** Clamp a vertex to the frame [0,w] x [0,h]. */
export function clampVertex(p: Vertex, w: number, h: number): Vertex {
  return [Math.max(0, Math.min(w, p[0])), Math.max(0, Math.min(h, p[1]))];
}
