from mosaic_worker.detect import Detection
from mosaic_worker.tracker import Tracker, block_size, to_segments


def D(x, y, w=60, h=60, s=0.9):
    return Detection((int(x), int(y), w, h), s)


def run(fps, frames_dets, size=None):
    t = Tracker(fps, frame_size=size)
    for i, dets in enumerate(frames_dets):
        t.update(i, dets)
    return t.finish()


def expand(box, ratio=0.25):
    x, y, w, h = box
    cx, cy = x + w / 2, y + h / 2
    nw, nh = w * (1 + ratio), h * (1 + ratio)
    return (round(cx - nw / 2), round(cy - nh / 2), round(nw), round(nh))


def test_crossing_faces_never_share_a_track():
    # A moves right along y=100, B moves left along y=130; they overlap in the middle.
    n = 60
    dets = []
    for i in range(n):
        ax, bx = 50 + i * 8, 530 - i * 8
        dets.append([D(ax, 100), D(bx, 130)])
    tracks = run(30, dets)
    for tr in tracks:
        # a track's raw center path must stay on one of the two lines (no A<->B switch)
        ys = {round((b[1] + b[3] / 2 - 30) / 10) * 10 for b in tr.frames.values()}
        assert len(ys) == 1, f"track {tr.id} mixes both paths: {ys}"
    covered_a = sum(len(tr.frames) for tr in tracks if abs(list(tr.frames.values())[0][1] - 100) < 20)
    assert covered_a >= n  # nothing lost


def test_gap_hold_30fps_5_frames_same_track():
    dets = [[D(100, 100)] for _ in range(10)] + [[] for _ in range(5)] + [[D(100, 100)] for _ in range(10)]
    tracks = run(30, dets)
    assert len(tracks) == 1
    assert tracks[0].held == set(range(10, 15))
    assert set(tracks[0].frames) == set(range(25))


def test_gap_hold_30fps_30_frame_gap_holds_15_then_new_track():
    dets = [[D(100, 100)] for _ in range(10)] + [[] for _ in range(30)] + [[D(100, 100)] for _ in range(10)]
    tracks = run(30, dets)
    assert len(tracks) == 2
    first, second = tracks
    assert first.held == set(range(10, 25))  # round(0.5*30) = 15 frames
    assert max(first.frames) == 24
    assert min(second.frames) == 40 and not second.held


def test_gap_hold_60fps_is_30_frames():
    dets = [[D(100, 100)] for _ in range(10)] + [[] for _ in range(60)]
    tracks = run(60, dets)
    assert len(tracks) == 1
    assert len(tracks[0].held) == 30


def test_hold_box_grows_5_percent_per_frame_before_expansion():
    dets = [[D(100, 100, 100, 100)] for _ in range(3)] + [[] for _ in range(3)]
    tr = run(30, dets)[0]
    # frame 3 is the first held frame: size = 100 * 1.05, then expanded 25% once
    assert tr.frames[2][2] == round(100 * 1.25)
    w3 = tr.frames[3][2]
    assert w3 == round(100 * 1.05 * 1.25)
    assert tr.frames[5][2] == round(100 * 1.05 ** 3 * 1.25)


def test_hold_uses_constant_velocity_prediction():
    dets = [[D(100 + 10 * i, 100)] for i in range(10)] + [[] for _ in range(3)]
    tr = run(30, dets)[0]
    cx = lambda b: b[0] + b[2] / 2  # noqa: E731
    assert cx(tr.frames[10]) > cx(tr.frames[9])
    assert abs((cx(tr.frames[11]) - cx(tr.frames[10])) - 10) <= 2


def test_big_jump_forces_new_track():
    # center moves 0.6 * diagonal in one frame: IoU would be 0 anyway, force-split must hold
    diag = (60 ** 2 + 60 ** 2) ** 0.5
    dets = [[D(100, 100)] for _ in range(5)] + [[D(100 + 0.6 * diag, 100)] for _ in range(5)]
    tracks = run(30, dets)
    assert len(tracks) == 2


def test_small_move_keeps_track():
    dets = [[D(100 + 10 * i, 100)] for i in range(20)]
    assert len(run(30, dets)) == 1


def test_expansion_applied_once_and_clamped():
    raw = (100, 100, 80, 40)
    tracks = run(30, [[Detection(raw, 0.9)]] * 3)
    assert tracks[0].frames[1] == expand(raw)
    tracks = run(30, [[Detection((0, 0, 40, 40), 0.9)]] * 3, size=(640, 360))
    x, y, w, h = tracks[0].frames[0]
    assert x == 0 and y == 0 and w == 45 and h == 45  # clamped at the frame corner


def test_short_track_kept():
    tracks = run(30, [[D(100, 100)], [D(100, 100)]])
    assert len(tracks) == 1 and len(tracks[0].frames) == 2


def test_low_score_detection_matches_existing_track_second_stage():
    dets = [[D(100, 100, s=0.9)] for _ in range(5)] + [[D(101, 100, s=0.52)] for _ in range(5)]
    tracks = run(30, dets)
    assert len(tracks) == 1
    assert tracks[0].scores[7] == 0.52


def test_update_reports_assignments():
    t = Tracker(30)
    a = t.update(0, [D(100, 100)])
    assert list(a) == ["t1"]
    b = t.update(1, [D(101, 100)])
    assert list(b) == ["t1"]


def test_block_size_and_segments():
    tr = run(30, [[D(100, 100, 100, 80)] for _ in range(5)])[0]
    # expanded short side = 100 -> 100 // 8 = 12
    assert block_size(tr) == 12
    tiny = run(30, [[D(10, 10, 20, 20)] for _ in range(3)])[0]
    assert block_size(tiny) == 8
    assert to_segments([1, 2, 3, 7, 8, 20]) == [[1, 3], [7, 8], [20, 20]]


def test_low_score_detection_never_starts_a_track():
    # ByteTrack rule: scores below HIGH_SCORE (0.6) may only extend an existing track.
    # Regression: food/texture hits at 0.5-0.6 each became a 0.5s held mosaic.
    tracks = run(60, [[D(400, 300, s=0.55)]] + [[] for _ in range(40)])
    assert tracks == []


def test_low_score_face_seen_strongly_once_stays_covered():
    # A partly hidden face: one confident hit, then only weak hits -> one continuous track.
    dets = [[D(100, 100, s=0.65)]] + [[D(100 + i, 100, s=0.55)] for i in range(1, 30)]
    tracks = run(60, dets)
    assert len(tracks) == 1
    assert len(tracks[0].frames) == 30
