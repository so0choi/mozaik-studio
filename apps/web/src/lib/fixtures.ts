// Test-only helper: loads the shared contract fixtures from the repo root.
import tracksSample from '../../../../contracts/fixtures/tracks.sample.json';
import editsSample from '../../../../contracts/fixtures/edits.sample.json';
import manualSample from '../../../../contracts/fixtures/manual.sample.json';
import reviewSample from '../../../../contracts/fixtures/review.sample.json';
import expectedRegionsSample from '../../../../contracts/fixtures/expected-regions.json';
import effectParamsSample from '../../../../contracts/fixtures/effect-params.json';
import shapeMasksSample from '../../../../contracts/fixtures/shape-masks.json';
import softEllipseSample from '../../../../contracts/fixtures/soft-ellipse-alpha.json';
import type { Edits, ManualDoc, ReviewDoc, TracksDoc } from './types';

export const tracksDoc = tracksSample as unknown as TracksDoc;
export const edits = editsSample as unknown as Edits;
export const manualDocs = manualSample as unknown as ManualDoc[];
export const reviewDoc = reviewSample as unknown as ReviewDoc;
export const expectedRegions = expectedRegionsSample as unknown as Record<string, unknown>;
export const effectParamCases = (effectParamsSample as { cases: { fn: string; args: number[]; expected: number }[] }).cases;
export const shapeMaskCases = shapeMasksSample as unknown as {
  name: string;
  shape: 'rect' | 'ellipse' | 'polygon';
  w: number;
  h: number;
  points: [number, number][] | null;
  /** optional [x0, y0, x1, y1] in box coords; rows then describe only that window */
  window?: [number, number, number, number];
  rows: string[];
}[];
export const softEllipseCases = (softEllipseSample as unknown as {
  cases: { name: string; box: [number, number, number, number]; effect: { type: string }; samples: [number, number, number][] }[];
}).cases;
