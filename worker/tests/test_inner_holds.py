from mosaic_worker.link import cover_inner_holds
from mosaic_worker.tracker import Track


def _track(frames, reals, tid="t1"):
    return Track(tid, frames, {f: 0.9 for f in reals}, {f for f in frames if f not in reals})


def test_held_frames_between_detections_cover_both_neighbours():
    # partial detection at 0 (drifting right), real face found further left at 3
    t = _track({0: (100, 0, 20, 20), 1: (110, 0, 21, 21), 2: (120, 0, 22, 22), 3: (60, 0, 80, 40)}, [0, 3])
    out = cover_inner_holds([t])[0]
    for f in (1, 2):
        x, y, w, h = out.frames[f]
        assert x <= 60 and x + w >= 140 and y <= 0 and y + h >= 40
    assert out.frames[0] == t.frames[0] and out.frames[3] == t.frames[3]
    assert out.held == {1, 2}


def test_trailing_holds_untouched():
    t = _track({0: (0, 0, 10, 10), 1: (5, 0, 10, 10), 2: (10, 0, 10, 10)}, [0])
    assert cover_inner_holds([t])[0].frames == t.frames


def test_cut_between_detections_skipped():
    t = _track({0: (0, 0, 10, 10), 1: (5, 0, 10, 10), 5: (300, 0, 10, 10)}, [0, 5])
    assert cover_inner_holds([t], cuts={3})[0].frames[1] == (5, 0, 10, 10)


def test_skip_ids_untouched():
    t = _track({0: (0, 0, 10, 10), 1: (5, 0, 10, 10), 2: (300, 0, 10, 10)}, [0, 2])
    assert cover_inner_holds([t], skip={"t1"})[0].frames[1] == (5, 0, 10, 10)
