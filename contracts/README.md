# Contracts

Spec §3 (`docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md`) is the source of truth.

`fixtures/` holds one 640×360, 30fps, 90-frame job:
- `tracks.sample.json` — t1 (always), t2 (always, split at 45 into t2a/t2b), t3 (frames 30–59)
- `edits.sample.json` — t1 and t2b visible; manual m1 trimmed to 44–46; m2 deleted
- `manual.sample.json` — manual propagation outputs (m1 frames 40–50, m2 frames 5–15)
- `expected-mask-frames.json` — boxes to mosaic at frames 0/44/45/47/89, `[x,y,w,h,blockSize]` sorted by (x,y)

Rules encoded by the expected values:
- Default is mosaic; only `visible` track ids (or groups) are skipped.
- Split at frame F: `<id>a` covers frames < F, `<id>b` covers frames ≥ F.
- Manual boxes: skip `deleted`; when `trim` is set keep only frames within [trim0, trim1]; block = max(8, min(w,h)//8).
- Track boxes use the track's fixed `blockSize`. Boxes are already expanded; never expand again.
