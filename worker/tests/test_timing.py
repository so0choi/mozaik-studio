from mosaic_worker.jobs import build_tracks_doc
from mosaic_worker.normalize import Meta


def _meta():
    return Meta(fps=30, width=640, height=360, frame_count=10, duration_sec=1.0, has_audio=False)


def test_timing_is_added_when_given():
    doc = build_tracks_doc(_meta(), [], {}, timing={"normalizeSec": 104.2, "analyzeSec": 382.0})
    assert doc["timing"] == {"normalizeSec": 104.2, "analyzeSec": 382.0}


def test_timing_absent_without_argument():
    assert "timing" not in build_tracks_doc(_meta(), [], {})
