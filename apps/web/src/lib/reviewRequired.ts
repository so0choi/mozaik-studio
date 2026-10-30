import type { Edits, ReviewItem } from './types';

/**
 * A review item is REQUIRED only when it can still expose a face given the
 * current edits. Keep in sync with apps/api/src/jobs/review-required.ts.
 * Track ids in items are base ids (t2); after a split edits may use t2a / t2b.
 */
export function isRequired(item: ReviewItem, edits: Pick<Edits, 'visible' | 'reviewed'>): boolean {
  if (edits.reviewed.includes(item.id)) return false;
  const visible = new Set(edits.visible);
  const visibleAny = (x: string) => visible.has(x) || visible.has(`${x}a`) || visible.has(`${x}b`);
  const maskedAny = (x: string) => !(visible.has(x) || (visible.has(`${x}a`) && visible.has(`${x}b`)));
  if (item.type === 'crossing') {
    const [a, b] = item.trackIds;
    if (a === undefined || b === undefined) return true;
    return (visibleAny(a) && maskedAny(b)) || (visibleAny(b) && maskedAny(a));
  }
  const t = item.trackIds[0];
  return t === undefined ? true : maskedAny(t);
}

export function requiredItems(items: ReviewItem[], edits: Pick<Edits, 'visible' | 'reviewed'>): ReviewItem[] {
  return items.filter((i) => isRequired(i, edits));
}
