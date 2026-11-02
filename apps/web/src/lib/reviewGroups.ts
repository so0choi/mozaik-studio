import { markReviewed } from './edits';
import type { Edits, ReviewItem } from './types';

export const GROUP_SEC = 5;

export interface ReviewGroup {
  key: number;
  startFrame: number;
  endFrame: number;
  items: ReviewItem[];
}

/** Crossings need an explicit choice (which person is which), so a bulk confirm never covers them. */
export const bulkConfirmable = (item: ReviewItem) => item.type !== 'crossing';

const byStart = (a: ReviewItem, b: ReviewItem) =>
  a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Bucket items into fixed time windows; within a window, likely-real items come before suspect ones. */
export function groupItems(
  items: ReviewItem[],
  fps: number,
  isSuspect: (item: ReviewItem) => boolean,
  windowSec = GROUP_SEC,
): ReviewGroup[] {
  const w = Math.max(1, Math.round(windowSec * fps));
  const buckets = new Map<number, ReviewItem[]>();
  for (const it of items) {
    const key = Math.floor(it.startFrame / w);
    const list = buckets.get(key);
    if (list) list.push(it);
    else buckets.set(key, [it]);
  }
  return [...buckets.keys()]
    .sort((a, b) => a - b)
    .map((key) => {
      const list = buckets.get(key)!;
      const real = list.filter((i) => !isSuspect(i)).sort(byStart);
      const suspect = list.filter((i) => isSuspect(i)).sort(byStart);
      return { key, startFrame: key * w, endFrame: (key + 1) * w - 1, items: [...real, ...suspect] };
    });
}

export function groupOf(groups: ReviewGroup[], itemId: string): ReviewGroup | null {
  return groups.find((g) => g.items.some((i) => i.id === itemId)) ?? null;
}

/** Marks every bulk-confirmable item of the group reviewed. Never touches visibility. */
export function confirmGroupEdits(edits: Edits, group: ReviewGroup): Edits {
  return group.items.filter(bulkConfirmable).reduce((e, it) => markReviewed(e, it.id), edits);
}
