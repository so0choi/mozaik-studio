"""Analyze a job: normalize -> detect -> track -> thumbnails -> tracks.json / review.json."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import cv2

from .detect import FaceDetector
from .link import link_fragments, trim_holds_at_cuts
from .normalize import Meta, find_original, normalize
from .person import PersonGate
from .review import build_review
from .status import MSG_ANALYZE_FAILED, UserFacingError, atomic_write_json
from .thumbs import ThumbCollector
from .tracker import Tracker, block_size, to_segments
from .scenecut import SceneCuts
from .verify import TrackVerifier

Progress = Callable[[str, int], None]

RENDER_CONFIG = {"expandRatio": 0.25, "blockDivisor": 8, "minBlock": 8, "gapHoldSec": 0.5}


def linked_suspects(groups: dict[str, list[str]], part_suspects: set[str]) -> set[str]:
    """A linked track is suspect only if all of its parts are."""
    return {kept for kept, parts in groups.items() if all(p in part_suspects for p in parts)}


def linked_person_states(groups: dict[str, list[str]], part_state: Callable[[str], str]) -> dict[str, str]:
    """Person-gate state of a linked track: support if any part is supported, else no_support if any part is."""
    out: dict[str, str] = {}
    for kept, parts in groups.items():
        states = {part_state(p) for p in parts}
        out[kept] = "support" if "support" in states else "no_support" if "no_support" in states else "unknown"
    return out


def nonface_ids(suspects, states: dict[str, str]) -> set[str]:
    """Likely not a face: failed the crop re-check AND no person box has a head where the face is. unknown never counts.

    Only pre-selects tiles for the reviewer; never unmasks anything (see person.py).
    """
    return {t for t in suspects if states.get(t) == "no_support"}


def likely_face_ids(track_ids, suspects, states: dict[str, str]) -> set[str]:
    """Tracks worth a reviewer's time: passed the crop re-check and not contradicted by the person gate."""
    return {t for t in track_ids if t not in suspects and states.get(t, "unknown") != "no_support"}


def detect_and_track(video: Path, meta: Meta, detector: FaceDetector, progress: Progress | None = None, person_detector=None):
    """Single decoding pass: detection, tracking and thumbnail collection (E5)."""
    cap = cv2.VideoCapture(str(video))
    if not cap.isOpened():
        raise UserFacingError(MSG_ANALYZE_FAILED)
    tracker = Tracker(meta.fps, frame_size=(meta.width, meta.height))
    thumbs = ThumbCollector(meta.fps)
    verifier = TrackVerifier()
    person = PersonGate(meta.fps, detector=person_detector)
    scene = SceneCuts(meta.fps)
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
            person.observe(idx, frame, assigned)
            scene.observe(idx, frame)
            idx += 1
            if progress:
                pct = min(99, int(idx * 100 / max(1, meta.frame_count)))
                if pct != last_pct:
                    last_pct = pct
                    progress("analyzing", pct)
    finally:
        cap.release()
    scene.finish()
    person.finish()
    tracks, groups = link_fragments(tracker.finish(), meta.fps, scene.cuts)
    # a held box keeps a lost face masked; after a cut the shot changed, so the old box would cover the new scene
    tracks = trim_holds_at_cuts(tracks, scene.cuts)
    # A suspect alone is only a hint and stays masked. If the person gate also finds no head there it is flagged
    # `nonface` (pre-selected in the review UI). Auto-unmask was tried and rejected: on a crowded street vlog
    # 8 of 100 sampled such tracks were real faces (close-ups filling the frame, small crowd faces).
    part_suspects = {p for parts in groups.values() for p in parts if not verifier.keep(p)}
    suspects = linked_suspects(groups, part_suspects)
    thumbs.merge(groups)
    return tracks, thumbs, suspects, scene.cuts, linked_person_states(groups, person.state)


def build_tracks_doc(meta: Meta, tracks, thumb_info: dict, suspects: set[str] | frozenset = frozenset(), nonface: set[str] | frozenset = frozenset()) -> dict:
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
                "nonface": t.id in nonface,
            }
        )
    return {
        "version": 1,
        "fps": meta.fps, "width": meta.width, "height": meta.height, "frameCount": meta.frame_count,
        "render_config": dict(RENDER_CONFIG),
        "tracks": docs,
    }


def analyze(job_dir: Path, progress: Progress | None = None, detector: FaceDetector | None = None, meta: Meta | None = None, person_detector=None) -> None:
    """Detect/track an already normalized job. Writes tracks.json, review.json and thumbs/."""
    from .normalize import load_meta

    job_dir = Path(job_dir)
    meta = meta or load_meta(job_dir)
    detector = detector or FaceDetector()
    tracks, thumbs, suspects, cuts, person_states = detect_and_track(job_dir / "normalized.mp4", meta, detector, progress, person_detector)
    info = thumbs.write([t.id for t in tracks], job_dir)
    nonface = nonface_ids(suspects, person_states)
    likely = likely_face_ids([t.id for t in tracks], suspects, person_states)
    atomic_write_json(job_dir / "tracks.json", build_tracks_doc(meta, tracks, info, suspects, nonface))
    atomic_write_json(job_dir / "review.json", build_review(tracks, meta.fps, (meta.width, meta.height), meta.frame_count, cuts, suspects, likely))
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
