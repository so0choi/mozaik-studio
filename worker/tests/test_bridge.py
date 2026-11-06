import json

from mosaic_worker import jobs
from mosaic_worker.link import bridge_gaps
from mosaic_worker.normalize import Meta
from mosaic_worker.review import build_review
from mosaic_worker.tracker import Track

FPS = 24


def mk(tid, real, held=(), box=(100, 100, 50, 50)):
    frames = {f: box for f in list(real) + list(held)}
    return Track(tid, frames, {f: 0.9 for f in real}, set(held))


def case(b_start=28, b_box=(110, 100, 50, 50), a_box=(100, 100, 50, 50), cuts=frozenset(), skip=frozenset()):
    a = mk("t2", range(0, 11), held=range(11, 16), box=a_box)
    b = mk("t8", range(b_start, b_start + 10), box=b_box)
    return a, b, bridge_gaps([a, b], FPS, cuts, skip)


def test_fills_measured_gap_as_held_interpolated_max_size():
    a, b, out = case(b_box=(130, 100, 60, 40))
    na = out[0]
    assert na.id == "t2" and out[1] is b
    assert set(range(16, 28)) <= set(na.frames) and 28 not in na.frames
    assert set(range(11, 28)) <= na.held and max(na.scores) == 10 and set(na.scores) == set(range(11))
    for f in range(16, 28):
        x, y, w, h = na.frames[f]
        assert (w, h) == (60, 50)
    cx = lambda f: na.frames[f][0] + na.frames[f][2] / 2
    assert cx(16) < cx(22) < cx(27)
    assert abs(cx(27) - (130 + 30)) < 8  # nearly at B's first centre


def test_no_bridge_cases():
    for kw in (
        dict(b_box=(100 + 2 * 40 + 80, 100, 50, 50)),  # > 2 raw sides away (side 40)
        dict(b_start=10 + 60 + 1),  # after lr + 2.5 s
        dict(b_box=(110, 100, 160, 160)),  # size ratio > 3
        dict(cuts=frozenset({20})),
        dict(b_start=16),  # B starts at L + 1 (no gap)
        dict(skip=frozenset({"t2"})),
        dict(skip=frozenset({"t8"})),
    ):
        a, b, out = case(**kw)
        assert out[0] is a, kw


def test_bridges_two_second_miss():
    # pexels-9003393 at 9 s: a raised arm hid a profile from YuNet for 2.08 s (last detection to next track).
    a, b, out = case(b_start=10 + 50)
    assert set(range(16, 60)) <= set(out[0].frames) and 60 not in out[0].frames


def test_earliest_candidate_wins():
    a = mk("t1", range(0, 11), held=range(11, 16))
    b = mk("t2", range(30, 40), box=(100, 100, 50, 50))
    c = mk("t3", range(24, 34), box=(120, 100, 50, 50))
    out = bridge_gaps([a, b, c], FPS)
    assert max(out[0].frames) == 23 and 24 not in out[0].frames


def test_inputs_not_mutated():
    a, b, out = case()
    assert out[0] is not a and max(a.frames) == 15 and a.held == set(range(11, 16))
    assert len(a.scores) == 11


def test_no_trailing_gap_review_item_after_bridge():
    a, b, out = case(b_box=(100, 100, 50, 50))
    doc = build_review(out, FPS, (640, 360), 100, frozenset())
    assert not [i for i in doc["items"] if i["type"] == "gap" and i["trackIds"] == ["t2"]]


def test_moving_b_may_still_raise_gap_item():
    # Documents a limit: if B's first box is not inside A's last bridged box, the existing exemption does not apply.
    a, b, out = case(b_box=(110, 100, 50, 50))
    doc = build_review(out, FPS, (640, 360), 100, frozenset())
    assert [i for i in doc["items"] if i["type"] == "gap" and i["trackIds"] == ["t2"]]


class FakeThumbs:
    def write(self, ids, job_dir):
        return {}


def test_analyze_bridges_normal_pair_but_not_nonface(tmp_path, monkeypatch):
    meta = Meta(fps=24, width=640, height=360, frame_count=100, duration_sec=4.0, has_audio=False)
    a = mk("t1", range(0, 11), held=range(11, 16))
    b = mk("t2", range(28, 38))
    n = mk("t3", range(0, 11), held=range(11, 16), box=(400, 100, 50, 50))
    m = mk("t4", range(28, 38), box=(405, 100, 50, 50))

    def fake(video, mt, detector, progress=None, person_detector=None):
        return [a, b, n, m], FakeThumbs(), {"t3"}, frozenset(), {"t3": "no_support"}

    monkeypatch.setattr(jobs, "detect_and_track", fake)
    jobs.analyze(tmp_path, detector=object(), meta=meta)
    doc = json.loads((tmp_path / "tracks.json").read_text())
    segs = {t["id"]: t["segments"] for t in doc["tracks"]}
    assert segs["t1"] == [[0, 37]] or segs["t1"][-1][1] == 27
    assert segs["t3"][-1][1] == 15
