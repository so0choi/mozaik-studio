import numpy as np
import pytest

from mosaic_worker.holdcheck import drop_unlike_holds, hold_features
from mosaic_worker.tracker import Track

FPS = 24
BOX = (100, 100, 50, 60)
rng = np.random.default_rng(0)
G_A = rng.standard_normal(576).astype(np.float32)
G_A = (G_A - G_A.mean()) / (G_A.std() + 1e-6)
G_B = -G_A
H_A = np.ones((16, 8), np.float32)
H_A[0, 0] = 5
H_B = np.ones((16, 8), np.float32)
H_B[15, 7] = 5
SAME = (G_A, H_A)
UNLIKE = (G_B, H_B)


def mk(real, hold, box=BOX, tid="t1"):
    frames = {f: box for f in list(real) + list(hold)}
    return Track(tid, frames, {f: 0.7 for f in real}, set(hold))


def run(tracks, feats, **kw):
    return drop_unlike_holds(tracks, feats, FPS, **kw)


def test_unlike_held_frame_dropped():
    t = mk([0, 1], [10])
    out = run([t], {("t1", 0): SAME, ("t1", 1): SAME, ("t1", 10): UNLIKE})[0]
    assert 10 not in out.frames and out.held == set()


def test_similar_kept():
    t = mk([0, 1], [10])
    out = run([t], {("t1", 0): SAME, ("t1", 10): SAME})[0]
    assert 10 in out.frames and out.held == {10}


def test_protected_by_overlapping_real_detection_soon():
    t = mk([0], [10])
    o = mk([13], [], tid="t2")
    out = run([t, o], {("t1", 0): SAME, ("t1", 10): UNLIKE})
    assert 10 in out[0].frames


def test_unprotected_when_detection_beyond_window():
    t = mk([0], [10])
    o = mk([17], [], tid="t2")  # window = 6 frames -> 10..16
    out = run([t, o], {("t1", 0): SAME, ("t1", 10): UNLIKE})
    assert 10 not in out[0].frames


def test_real_frames_never_dropped():
    t = mk([0, 1, 2], [])
    out = run([t], {("t1", 0): SAME, ("t1", 1): UNLIKE, ("t1", 2): UNLIKE})[0]
    assert set(out.frames) == {0, 1, 2}


def test_missing_feats_kept():
    t = mk([0], [10])
    assert 10 in run([t], {("t1", 10): UNLIKE})[0].frames
    assert 10 in run([t], {("t1", 0): SAME})[0].frames


def test_hold_features_identical_content_ncc_one(tmp_path):
    cv2 = pytest.importorskip("cv2")
    p = str(tmp_path / "v.mp4")
    w = cv2.VideoWriter(p, cv2.VideoWriter_fourcc(*"mp4v"), 24, (64, 48))
    if not w.isOpened():
        pytest.skip("mp4v writer unavailable")
    img = np.random.default_rng(1).integers(0, 255, (48, 64, 3), dtype=np.uint8)
    for _ in range(4):
        w.write(img)
    w.release()
    t = Track("t1", {0: (10, 8, 30, 30), 2: (10, 8, 30, 30)}, {0: 0.9}, {2})
    feats = hold_features(p, [t])
    assert ("t1", 0) in feats and ("t1", 2) in feats
    g0, g2 = feats[("t1", 0)][0], feats[("t1", 2)][0]
    assert float(np.dot(g0, g2) / len(g0)) > 0.9


def test_lead_frame_not_protected_by_own_first_detection():
    # lead frame 8 precedes the first detection at 10; the only overlapping real box is the track's own
    t = mk([10], [8])
    out = run([t], {("t1", 8): UNLIKE, ("t1", 10): SAME})[0]
    assert 8 not in out.frames and out.held == set()


def test_lead_frame_protected_by_other_track_detection():
    t = mk([10], [8])
    o = mk([12], [], tid="t2")
    out = run([t, o], {("t1", 8): UNLIKE, ("t1", 10): SAME})
    assert 8 in out[0].frames and out[0].held == {8}


def test_held_after_detection_protected_by_own_next_detection():
    t = mk([0, 12], [6])
    out = run([t], {("t1", 0): SAME, ("t1", 6): UNLIKE, ("t1", 12): SAME})[0]
    assert 6 in out.frames and out.held == {6}


def test_lead_frame_not_protected_by_other_track_already_detecting_there():
    # t2 has REAL detections at 8..10 (it masks the face at 8 itself), so its overlapping detections do not protect t1's lead
    t = mk([10], [8])
    o = mk([8, 9, 10], [], tid="t2")
    out = run([t, o], {("t1", 8): UNLIKE, ("t1", 10): SAME})
    assert 8 not in out[0].frames and out[0].held == set()


def test_lead_frame_protected_by_other_track_with_only_held_box_there():
    # t2 has a held box at the lead frame 8 but no real detection there; its real detection at 10 overlaps t1's lead box
    t = mk([10], [8])
    o = mk([10], [8], tid="t2")
    out = run([t, o], {("t1", 8): UNLIKE, ("t1", 10): SAME})
    assert 8 in out[0].frames and out[0].held == {8}


def test_lead_frame_protected_by_other_track_starting_later():
    # t2 has no box at the lead frame 8; its first box and detection is at 10, overlapping t1's lead box
    t = mk([10], [8])
    o = mk([10, 11], [], tid="t2")
    out = run([t, o], {("t1", 8): UNLIKE, ("t1", 10): SAME})
    assert 8 in out[0].frames and out[0].held == {8}
