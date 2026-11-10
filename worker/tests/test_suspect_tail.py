from mosaic_worker.link import trim_suspect_tails
from mosaic_worker.tracker import Track

FPS = 24  # tail = round(0.25*24) = 6 frames
BOX = (100, 100, 50, 60)


def mk(tid, real, hold=(), box=BOX):
    frames = {f: box for f in list(real) + list(hold)}
    return Track(tid, frames, {f: 0.7 for f in real}, set(hold))


def test_flagged_tail_beyond_limit_removed():
    t = mk("t1", range(0, 10), hold=range(10, 30))
    out = trim_suspect_tails([t], FPS, {"t1"})[0]
    assert max(out.frames) == 9 + 6
    assert out.held == set(range(10, 16))
    assert set(range(0, 10)) <= set(out.frames)


def test_unflagged_untouched():
    t = mk("t1", range(0, 10), hold=range(10, 30))
    out = trim_suspect_tails([t], FPS, set())[0]
    assert max(out.frames) == 29


def test_continuation_keeps_tail():
    t = mk("t1", range(0, 10), hold=range(10, 30))
    o = mk("t2", range(31, 40), box=(110, 105, 50, 60))
    out = trim_suspect_tails([t, o], FPS, {"t1"})
    assert max(out[0].frames) == 29


def test_non_overlapping_continuation_does_not_keep_tail():
    t = mk("t1", range(0, 10), hold=range(10, 30))
    o = mk("t2", range(31, 40), box=(500, 500, 50, 60))
    out = trim_suspect_tails([t, o], FPS, {"t1"})
    assert max(out[0].frames) == 15


def test_short_tail_untouched():
    t = mk("t1", range(0, 10), hold=range(10, 14))
    assert max(trim_suspect_tails([t], FPS, {"t1"})[0].frames) == 13
