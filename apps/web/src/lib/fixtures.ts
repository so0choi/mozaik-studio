// Test-only helper: loads the shared contract fixtures from the repo root.
import tracksSample from '../../../../contracts/fixtures/tracks.sample.json';
import editsSample from '../../../../contracts/fixtures/edits.sample.json';
import manualSample from '../../../../contracts/fixtures/manual.sample.json';
import reviewSample from '../../../../contracts/fixtures/review.sample.json';
import expectedMask from '../../../../contracts/fixtures/expected-mask-frames.json';
import type { Edits, ManualDoc, ReviewDoc, TracksDoc } from './types';

export const tracksDoc = tracksSample as unknown as TracksDoc;
export const edits = editsSample as unknown as Edits;
export const manualDocs = manualSample as unknown as ManualDoc[];
export const reviewDoc = reviewSample as unknown as ReviewDoc;
export const expected = expectedMask as unknown as Record<string, unknown>;
