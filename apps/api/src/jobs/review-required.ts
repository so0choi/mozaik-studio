/**
 * A review item blocks rendering only when it can still expose a face given the
 * current edits. Keep in sync with apps/web/src/lib/reviewRequired.ts.
 */
export interface ReviewItemLike {
  id: string;
  type: string;
  trackIds: string[];
}
export interface EditsLike {
  visible?: string[];
  reviewed?: string[];
}

export function isRequired(item: ReviewItemLike, edits: EditsLike): boolean {
  if (new Set(edits.reviewed ?? []).has(item.id)) return false;
  const visible = new Set(edits.visible ?? []);
  const visibleAny = (x: string) => visible.has(x) || visible.has(x + 'a') || visible.has(x + 'b');
  const maskedAny = (x: string) => !(visible.has(x) || (visible.has(x + 'a') && visible.has(x + 'b')));
  if (item.type === 'crossing') {
    const [a, b] = item.trackIds;
    if (a === undefined || b === undefined) return true;
    return (visibleAny(a) && maskedAny(b)) || (visibleAny(b) && maskedAny(a));
  }
  const t = item.trackIds[0];
  return t === undefined ? true : maskedAny(t);
}

export function requiredItems<T extends ReviewItemLike>(items: T[], edits: EditsLike): T[] {
  return items.filter((i) => isRequired(i, edits));
}
