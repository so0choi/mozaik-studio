/** [x, y, w, h] in source-video pixels. */
export type Box = [number, number, number, number];
/** [x, y, w, h, blockSize] in source-video pixels. */
export type MaskBox = [number, number, number, number, number];

export interface Track {
  id: string;
  thumb: string;
  samples: string[];
  blockSize: number;
  segments: [number, number][];
  frames: Record<string, Box>;
  scores?: Record<string, number>;
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

export interface ManualEdit {
  id: string;
  anchors: { frame: number; box: Box }[];
  trim: [number, number] | null;
  deleted: boolean;
}

export interface Edits {
  version: number;
  visible: string[];
  groups: Group[];
  splits: Split[];
  manual: ManualEdit[];
  reviewed: string[];
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
  hasOutput: boolean;
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
}
