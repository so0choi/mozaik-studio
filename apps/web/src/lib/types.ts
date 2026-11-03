/** [x, y, w, h] in source-video pixels. */
export type Box = [number, number, number, number];

export interface Track {
  id: string;
  thumb: string;
  samples: string[];
  blockSize: number;
  segments: [number, number][];
  frames: Record<string, Box>;
  scores?: Record<string, number>;
  /** worker hint: a second look found no face here (may be food/hand/texture). Still masked by default. */
  suspect?: boolean;
}

export interface TracksDoc {
  version: number;
  fps: number;
  width: number;
  height: number;
  frameCount: number;
  render_config?: Record<string, number>;
  tracks: Track[];
}

export type ReviewType = 'low_confidence' | 'gap' | 'crossing';

export interface ReviewItem {
  id: string;
  type: ReviewType;
  trackIds: string[];
  startFrame: number;
  endFrame: number;
  box: Box;
  /** absent on old jobs = required; crossing never has it */
  severity?: 'required' | 'advisory';
}

export interface ReviewDoc {
  items: ReviewItem[];
}

export interface Group {
  id: string;
  trackIds: string[];
  label?: string;
}

export interface Split {
  trackId: string;
  frame: number;
}

export type EffectType = 'mosaic' | 'blur' | 'color';

export interface Effect {
  type: EffectType;
  /** integer 1-5 */
  strength: number;
  /** #rrggbb, used by type 'color' */
  color: string;
}

export interface Effects {
  default: Effect;
  background: Effect | null;
  overrides: Record<string, Effect>;
}

export type Shape = 'rect' | 'ellipse' | 'polygon';

/** One masked area of one frame, as computed by maskRegions (mirrors the worker's Region). */
export interface Region {
  id: string;
  shape: Shape;
  box: Box;
  /** absolute integer coordinates, polygon only */
  points: [number, number][] | null;
  effect: Effect;
  block: number;
}

export interface ManualEdit {
  id: string;
  anchors: { frame: number; box: Box }[];
  trim: [number, number] | null;
  deleted: boolean;
  shape?: Shape;
  /** polygon vertices normalized to the drawn anchor box (u, v in 0..1) */
  points?: [number, number][];
}

export interface Edits {
  version: number;
  visible: string[];
  groups: Group[];
  splits: Split[];
  manual: ManualEdit[];
  reviewed: string[];
  effects?: Effects;
}

/** manual/{id}.json */
export interface ManualDoc {
  id: string;
  frames: Record<string, Box>;
  segments: [number, number][];
}

export type ManualState = 'tracking' | 'done' | 'failed';

export type JobState =
  | 'queued'
  | 'normalizing'
  | 'analyzing'
  | 'ready'
  | 'rendering'
  | 'rendered'
  | 'failed';

export interface Job {
  id: string;
  filename: string;
  createdAt: string;
  state: JobState;
  progress: number;
  error: string | null;
  /** output.mp4 exists and was rendered from the current saved edits (server-checked). */
  hasOutput: boolean;
  /** output.mp4 exists but the saved edits changed after it was rendered. */
  outputStale: boolean;
}

export interface Person {
  /** group id, or piece id (t3 / t2a) for ungrouped persons */
  key: string;
  label: string;
  /** piece-aware track ids (t2a, t2b, ...) as used by edits.visible */
  trackIds: string[];
  visible: boolean;
  thumb: string;
  samples: string[];
  fragmentCount: number;
  appearSec: number;
  segments: [number, number][];
  isGroup: boolean;
  /** true only if every piece's track is suspect */
  suspect: boolean;
}
