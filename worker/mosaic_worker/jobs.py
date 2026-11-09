"""Analyze a job: normalize -> detect -> track -> thumbnails -> tracks.json / review.json."""
from __future__ import annotations

from pathlib import Path
from typing import Callable

import cv2

from .detect import FaceDetector
from .link import bridge_gaps, cover_inner_holds, cover_leading, link_fragments, trim_holds_at_cuts
from .normalize import Meta, find_original, normalize
from .person import PersonGate
from .review import CROSS_IOU, _crossing_boxes, build_review
from .status import MSG_ANALYZE_FAILED, UserFacingError, atomic_write_json
from .thumbs import ThumbCollector
from .tracker import Tracker, block_size, iou, to_segments
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

    These are unmasked at the end of analysis (seed_unmasked); see person.py for the measured risk.
    """
    return {t for t in suspects if states.get(t) == "no_support"}


# A flagged box that YuNet found only a few times and that is far larger than the other faces on screen is a
# body part read as a face (pexels-9003393 31 s: a chest, 3.6x). Measured on three labeled videos: at 3.5x all
# 3 such boxes were non-faces; the closest real face (capped and masked, like-jennie 114 s) sat at 2.99x.
OVERSIZE_RATIO = 3.5
OVERSIZE_MAX_REAL = 3


def oversized_suspect_ids(tracks, flagged, skip=frozenset()) -> set[str]:
    """Flagged tracks with at most OVERSIZE_MAX_REAL detections whose median box is >= OVERSIZE_RATIO times the
    median width of the other masked faces detected on the same frames. No other face there: never counts."""
    widths: dict[int, list[tuple[str, int]]] = {}
    for t in tracks:
        if t.id in skip:
            continue
        for f in t.scores:
            if f in t.frames:
                widths.setdefault(f, []).append((t.id, t.frames[f][2]))
    out = set()
    for t in tracks:
        if t.id not in flagged or t.id in skip or not 0 < len(t.scores) <= OVERSIZE_MAX_REAL:
            continue
        reals = [f for f in t.scores if f in t.frames]
        others = sorted(w for f in reals for tid, w in widths.get(f, []) if tid != t.id)
        if not reals or not others:
            continue
        own = sorted(t.frames[f][2] for f in reals)
        if _median(own) >= OVERSIZE_RATIO * _median(others):
            out.add(t.id)
    return out


def _median(xs: list) -> float:
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def seed_unmasked(job_dir: Path, ids) -> None:
    """Add likely non-faces to edits.visible so they start unmasked; keeps every other edit."""
    from .render import _read_json, default_edits

    if not ids:
        return
    path = Path(job_dir) / "edits.json"
    edits = _read_json(path, default_edits())
    visible = list(edits.get("visible") or [])
    visible += sorted(set(ids) - set(visible), key=lambda t: int(t[1:]) if t[1:].isdigit() else 0)
    edits["visible"] = visible
    atomic_write_json(path, edits)


def crossing_masked(tracks, unmask: set[str]) -> set[str]:
    """Ids in `unmask` whose box ever overlaps (review's crossing rule) a track that stays masked.

    Unmasking such a track would make that crossing a required review item (a tracker id swap there could
    leave the unmasked track on a real face), so it stays masked; it is still pre-checked in the UI.
    """
    boxes = {t.id: _crossing_boxes(t) for t in tracks}
    by_frame: dict[int, list[str]] = {}
    for tid, fb in boxes.items():
        for f in fb:
            by_frame.setdefault(f, []).append(tid)
    out: set[str] = set()
    while True:  # keeping one masked can create a new masked/unmasked crossing with another: repeat until stable
        added = False
        for f, ids in by_frame.items():
            for a in ids:
                if a not in unmask or a in out:
                    continue
                if any((b not in unmask or b in out) and iou(boxes[a][f], boxes[b][f]) > CROSS_IOU for b in ids if b != a):
                    out.add(a)
                    added = True
        if not added:
            return out


def bucket_ids(track_ids, suspects, states: dict[str, str]) -> set[str]:
    """Tracks listed in the "may not be a face" bucket: crop re-check failed, or no person head was found there.

    Membership only moves the tile into the bucket; it stays masked. Pre-checking is still nonface_ids only,
    because tracks that pass the crop re-check but lack a person include real faces (5 of 33 on one test video).
    """
    return set(suspects) | {t for t in track_ids if states.get(t) == "no_support"}


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
    # `nonface` and unmasked by default (seed_unmasked). Known risk, accepted by the product owner on 2026-11-05:
    # on a crowded street vlog 8 of 100 sampled such tracks were real faces (close-ups, small crowd faces).
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
    flagged = bucket_ids([t.id for t in tracks], suspects, person_states)
    nonface |= oversized_suspect_ids(tracks, flagged, skip=nonface)
    likely = likely_face_ids([t.id for t in tracks], suspects, person_states)
    # after suspects/nonface are known: likely non-faces must not get their masks extended
    tracks = cover_inner_holds(tracks, cuts, skip=nonface)
    tracks = bridge_gaps(tracks, meta.fps, cuts, skip=nonface)
    tracks = cover_leading(tracks, meta.fps, cuts, skip=nonface)
    bucket = bucket_ids([t.id for t in tracks], suspects, person_states)
    atomic_write_json(job_dir / "tracks.json", build_tracks_doc(meta, tracks, info, bucket, nonface))
    atomic_write_json(job_dir / "review.json", build_review(tracks, meta.fps, (meta.width, meta.height), meta.frame_count, cuts, suspects, likely))
    seed_unmasked(job_dir, nonface - crossing_masked(tracks, nonface))
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
