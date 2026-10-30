"""Analyze a job: normalize -> detect -> track -> thumbnails -> tracks.json / review.json."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import cv2

from .detect import FaceDetector
from .normalize import Meta, find_original, normalize
from .review import build_review
from .status import MSG_ANALYZE_FAILED, UserFacingError, atomic_write_json
from .thumbs import ThumbCollector
from .tracker import Tracker, block_size, to_segments
from .scenecut import SceneCuts
from .verify import TrackVerifier

Progress = Callable[[str, int], None]

RENDER_CONFIG = {"expandRatio": 0.25, "blockDivisor": 8, "minBlock": 8, "gapHoldSec": 0.5}


def detect_and_track(video: Path, meta: Meta, detector: FaceDetector, progress: Progress | None = None):
    """Single decoding pass: detection, tracking and thumbnail collection (E5)."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise UserFacingError(MSG_ANALYZE_FAILED)
    tracker = Tracker(meta.fps, frame_size=(meta.width, meta.height))
    thumbs = ThumbCollector(meta.fps)
    verifier = TrackVerifier()
    scene = SceneCuts()
    last_pct = -1
    try:
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            assigned = tracker.update(idx, detector.detect(frame))
            thumbs.observe(idx, frame, assigned)
            verifier.observe(frame, assigned)
            scene.observe(idx, frame)
            idx += 1
            if progress:
                pct = min(99, int(idx * 100 / max(1, meta.frame_count)))
                if pct != last_pct:
                    last_pct = pct
                    progress("analyzing", pct)
    finally:
        cap.release()
    tracks = tracker.finish()
    # Only a hint for the reviewer: suspect tracks stay masked like every other track.
    suspects = {t.id for t in tracks if not verifier.keep(t.id)}
    return tracks, thumbs, suspects, scene.cuts


def build_tracks_doc(meta: Meta, tracks, thumb_info: dict, suspects: set[str] | frozenset = frozenset()) -> dict:
    docs = []
    for t in tracks:
        info = thumb_info.get(t.id, {"thumb": None, "samples": []})
        docs.append(
            {
                "id": t.id,
                "thumb": info["thumb"],
                "samples": info["samples"],
                "blockSize": block_size(t),
                "segments": to_segments(t.frames),
                "frames": {str(f): list(b) for f, b in sorted(t.frames.items())},
                "scores": {str(f): round(s, 4) for f, s in sorted(t.scores.items())},
                "suspect": t.id in suspects,
            }
        )
    return {
        "version": 1,
        "fps": meta.fps, "width": meta.width, "height": meta.height, "frameCount": meta.frame_count,
        "render_config": dict(RENDER_CONFIG),
        "tracks": docs,
    }


def analyze(job_dir: Path, progress: Progress | None = None, detector: FaceDetector | None = None, meta: Meta | None = None) -> None:
    """Detect/track an already normalized job. Writes tracks.json, review.json and thumbs/."""
    from .normalize import load_meta

    job_dir = Path(job_dir)
    meta = meta or load_meta(job_dir)
    detector = detector or FaceDetector()
    tracks, thumbs, suspects, cuts = detect_and_track(job_dir / "normalized.mp4", meta, detector, progress)
    info = thumbs.write([t.id for t in tracks], job_dir)
    atomic_write_json(job_dir / "tracks.json", build_tracks_doc(meta, tracks, info, suspects))
    atomic_write_json(job_dir / "review.json", build_review(tracks, meta.fps, (meta.width, meta.height), meta.frame_count, cuts))
    if progress:
        progress("analyzing", 100)


def run_analyze(job_dir: Path, progress: Progress, detector: FaceDetector | None = None, detector_factory=None) -> None:
    """Full analyze step as the queue runs it: normalize then analyze."""
    job_dir = Path(job_dir)
    progress("normalizing", 0)
    meta = normalize(find_original(job_dir), job_dir)
    progress("analyzing", 0)
    if detector is None and detector_factory is not None:
        detector = detector_factory()  # model is loaded only once normalization succeeded
    analyze(job_dir, progress, detector=detector, meta=meta)
