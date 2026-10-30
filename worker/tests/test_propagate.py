import json

from helpers import make_video, moving_face_frames
from mosaic_worker.normalize import normalize
from mosaic_worker.propagate import propagate


def _job(tmp_path, face_image, n=90):
    frames, pos = moving_face_frames(face_image, n=n)
    src = make_video(tmp_path / "original.mp4", frames, fps=30)
    normalize(src, tmp_path)
    return pos


def test_propagates_both_directions_following_the_face(tmp_path, face_image):
    pos = _job(tmp_path, face_image)
    x, y, s = pos[30]
    doc = propagate(tmp_path, "m1", {"frame": 30, "box": [x, y, s, s]}, [])
    frames = {int(f): b for f, b in doc["frames"].items()}
    assert (tmp_path / "manual" / "m1.json").exists()
    assert json.loads((tmp_path / "manual" / "m1.json").read_text()) == doc
    good = 0
    for f in range(90):
        if f not in frames:
            continue
        bx, by, bw, bh = frames[f]
        px, py, ps = pos[f]
        if abs((bx + bw / 2) - (px + ps / 2)) <= bw * 0.5 and abs((by + bh / 2) - (py + ps / 2)) <= bh * 0.5:
            good += 1
    assert good >= 0.8 * 90
    assert min(frames) <= 5 and max(frames) >= 85  # went backwards and forwards
    assert doc["segments"] == [[min(frames), max(frames)]]
    # anchor frame box is the drawn box expanded 25% (once)
    assert frames[30][2] == round(s * 1.25)


def test_reanchor_replaces_only_between_nearest_other_anchors(tmp_path, face_image):
    pos = _job(tmp_path, face_image)
    sentinel = [0, 0, 11, 11]
    old = {str(f): sentinel for f in list(range(0, 11)) + list(range(11, 70)) + list(range(70, 90))}
    (tmp_path / "manual").mkdir()
    (tmp_path / "manual" / "m1.json").write_text(json.dumps({"id": "m1", "frames": old, "segments": [[0, 89]]}))
    x, y, s = pos[40]
    doc = propagate(tmp_path, "m1", {"frame": 40, "box": [x, y, s, s]}, [10, 70])
    frames = {int(f): b for f, b in doc["frames"].items()}
    for f in list(range(0, 11)) + list(range(70, 90)):
        assert frames[f] == sentinel, f"frame {f} outside the anchors must be untouched"
    between = [f for f in range(11, 70) if f in frames]
    assert 40 in between and len(between) >= 40
    assert all(frames[f] != sentinel for f in between)
