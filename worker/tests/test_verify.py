import numpy as np

from mosaic_worker.detect import Detection
from mosaic_worker.verify import TrackVerifier, square_crops


def D(s, box=(100, 100, 60, 60)):
    return Detection(box, s)


class Scorer:
    """Fake crop scorer: returns a fixed score and counts calls."""

    def __init__(self, score):
        self.score = score
        self.calls = 0

    def __call__(self, frame, box):
        self.calls += 1
        return self.score


FRAME = np.zeros((360, 640, 3), np.uint8)


def test_confident_track_is_kept_without_verification():
    s = Scorer(0.0)
    v = TrackVerifier(min_score=0.6, crop_score=s)
    v.observe(FRAME, {"t1": D(0.92)})
    assert v.keep("t1") and s.calls == 0


def test_low_score_track_that_fails_crop_check_is_dropped():
    # food/texture: never confident, re-detection on the enlarged crop finds no face
    v = TrackVerifier(min_score=0.6, crop_score=Scorer(0.2))
    for _ in range(10):
        v.observe(FRAME, {"t2": D(0.7)})
    assert not v.keep("t2")


def test_low_score_track_that_passes_crop_check_is_kept():
    # occluded / eating face: low on the full frame, clear once enlarged
    v = TrackVerifier(min_score=0.6, crop_score=Scorer(0.89))
    v.observe(FRAME, {"t3": D(0.61)})
    assert v.keep("t3")


def test_verification_is_capped_per_track():
    s = Scorer(0.1)
    v = TrackVerifier(min_score=0.6, crop_score=s)
    for _ in range(50):
        v.observe(FRAME, {"t4": D(0.7)})
    assert s.calls == 6


def test_min_score_zero_disables_filtering():
    s = Scorer(0.0)
    v = TrackVerifier(min_score=0.0, crop_score=s)
    v.observe(FRAME, {"t5": D(0.55)})
    assert v.keep("t5") and s.calls == 0


def test_unknown_track_is_kept():
    # never observed (e.g. only held frames) -> do not drop anything we cannot judge
    v = TrackVerifier(min_score=0.6, crop_score=Scorer(0.0))
    assert v.keep("t9")


def test_square_crops_are_square_for_boxes_at_the_frame_edge():
    frame = np.full((360, 640, 3), 200, np.uint8)
    clamped, padded = square_crops(frame, (600, 300, 80, 80), side=320)
    assert clamped.shape == (320, 320, 3) and padded.shape == (320, 320, 3)
    # padded keeps geometry: the part outside the frame is black
    assert padded[-1, -1].tolist() == [0, 0, 0]


def test_build_tracks_doc_marks_suspects_but_keeps_them():
    from mosaic_worker.jobs import build_tracks_doc
    from mosaic_worker.normalize import Meta
    from mosaic_worker.tracker import Track

    meta = Meta(fps=30, width=640, height=360, frame_count=10, duration_sec=0.33, has_audio=False)
    tracks = [Track("t1", {0: (1, 1, 40, 40)}, {0: 0.95}, set()), Track("t2", {0: (100, 1, 40, 40)}, {0: 0.7}, set())]
    doc = build_tracks_doc(meta, tracks, {}, suspects={"t2"})
    by_id = {t["id"]: t for t in doc["tracks"]}
    assert set(by_id) == {"t1", "t2"}  # nothing is dropped
    assert by_id["t1"]["suspect"] is False and by_id["t2"]["suspect"] is True
