import type { Edits, ManualEdit } from './types';

/** Undo/redo stacks of whole-Edits snapshots (Edits are immutable, so snapshots are cheap). */
export interface History {
  past: Edits[];
  future: Edits[];
}

export const HISTORY_CAP = 100;

export const emptyHistory = (): History => ({ past: [], future: [] });

/** Record `prev` (the state before an edit). Clears the redo stack; keeps at most HISTORY_CAP entries. */
export function push(h: History, prev: Edits): History {
  return { past: [...h.past, prev].slice(-HISTORY_CAP), future: [] };
}

/**
 * Manual entries are kept as soft-deleted when they exist now but not in the snapshot we restore,
 * so undoing a creation really unmasks it in both the preview and the render.
 */
function keepManualAsDeleted(target: Edits, current: Edits): Edits {
  const have = new Set(target.manual.map((m) => m.id));
  const orphans: ManualEdit[] = current.manual.filter((m) => !have.has(m.id)).map((m) => ({ ...m, deleted: true }));
  return orphans.length ? { ...target, manual: [...target.manual, ...orphans] } : target;
}

export function undo(h: History, current: Edits): { history: History; edits: Edits } | null {
  if (!h.past.length) return null;
  const target = h.past[h.past.length - 1];
  return {
    history: { past: h.past.slice(0, -1), future: [...h.future, current].slice(-HISTORY_CAP) },
    edits: keepManualAsDeleted(target, current),
  };
}

export function redo(h: History, current: Edits): { history: History; edits: Edits } | null {
  if (!h.future.length) return null;
  const target = h.future[h.future.length - 1];
  return {
    history: { past: [...h.past, current].slice(-HISTORY_CAP), future: h.future.slice(0, -1) },
    edits: keepManualAsDeleted(target, current),
  };
}
