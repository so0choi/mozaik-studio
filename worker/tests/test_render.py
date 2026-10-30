import json

import cv2
import numpy as np
import pytest

from helpers import make_video, moving_face_frames
from mosaic_worker import jobs
from mosaic_worker.detect import FaceDetector
from mosaic_worker.normalize import probe
from mosaic_worker.render import pixelate, render
from mosaic_worker.status import UserFacingError


def _cells_uniform(frame, x, y, w, h, block):
    for cy in range(0, h, block):
        for cx in range(0, w, block):
            cell = frame[y + cy : y + min(cy + block, h), x + cx : x + min(cx + block, w)]
            flat = cell.reshape(-1, 3)
            if not (flat == flat[0]).all():
                return False
    return True


def test_pixelate_cells_uniform_and_outside_unchanged():
    rng = np.random.default_rng(0)
    frame = rng.integers(0, 256, (120, 160, 3), dtype=np.uint8)
    orig = frame.copy()
    box, block = (13, 17, 50, 43), 8  # sizes that are not multiples of the block
    pixelate(frame, box, block)
    x, y, w, h = box
    assert _cells_uniform(frame, x, y, w, h, block)
    assert not (frame[y : y + h, x : x + w] == orig[y : y + h, x : x + w]).all()
    mask = np.ones(frame.shape[:2], bool)
    mask[y : y + h, x : x + w] = False
    assert (frame[mask] == orig[mask]).all()


def test_pixelate_grid_origin_is_box_top_left():
    frame = np.arange(40 * 40 * 3, dtype=np.uint32).reshape(40, 40, 3).astype(np.uint8)
    pixelate(frame, (5, 5, 16, 16), 8)
    assert (frame[5:13, 5:13] == frame[5, 5]).all()
    assert (frame[13:21, 5:13] == frame[13, 5]).all()
    assert not (frame[5, 5] == frame[13, 5]).all()


def test_pixelate_clamps_to_frame():
    frame = np.full((50, 50, 3), 7, np.uint8)
    pixelate(frame, (-10, -10, 30, 30), 8)  # partially outside
    pixelate(frame, (45, 45, 30, 30), 8)
    pixelate(frame, (200, 200, 10, 10), 8)  # fully outside: no-op, no error
    assert frame.shape == (50, 50, 3)


def _setup_job(tmp_path, face_image, model_path, with_audio):
    frames, pos = moving_face_frames(face_image, n=60)
    make_video(tmp_path / "original.mp4", frames, fps=30, with_audio=with_audio)
    jobs.run_analyze(tmp_path, lambda s, p: None, detector=FaceDetector(model_path))
    return json.loads((tmp_path / "tracks.json").read_text())


def _frame(path, idx):
    cap = cv2.VideoCapture(str(path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
    ok, f = cap.read()
    cap.release()
    assert ok
    return f


@pytest.mark.parametrize("with_audio", [True, False])
def test_render_all_masked_keeps_length_and_audio(tmp_path, face_image, model_path, with_audio):
    doc = _setup_job(tmp_path, face_image, model_path, with_audio)
    assert doc["tracks"]
    progress = []
    out = render(tmp_path, lambda s, p: progress.append((s, p)))
    assert out == tmp_path / "output.mp4" and out.exists()
    src = tmp_path / "normalized.mp4"
    cap_in, cap_out = cv2.VideoCapture(str(src)), cv2.VideoCapture(str(out))
    assert int(cap_in.get(cv2.CAP_PROP_FRAME_COUNT)) == int(cap_out.get(cv2.CAP_PROP_FRAME_COUNT))
    cap_in.release(); cap_out.release()
    info_in, info_out = probe(src), probe(out)
    assert info_out.has_audio is with_audio and info_in.has_audio is with_audio
    assert info_out.start == pytest.approx(0.0, abs=1e-3)
    assert progress[-1] == ("rendering", 100)

    t = max(doc["tracks"], key=lambda t: len(t["frames"]))
    f = 30
    x, y, w, h = t["frames"][str(f)]
    a, b = _frame(src, f)[y : y + h, x : x + w].astype(int), _frame(out, f)[y : y + h, x : x + w].astype(int)
    assert np.abs(a - b).mean() > 4  # mask region differs from source
    assert (tmp_path / "output.tmp.mp4").exists() is False


def test_visible_track_is_not_pixelated(tmp_path, face_image, model_path):
    doc = _setup_job(tmp_path, face_image, model_path, False)
    ids = [t["id"] for t in doc["tracks"]]
    (tmp_path / "edits.json").write_text(json.dumps(
        {"version": 1, "visible": ids, "groups": [], "splits": [], "manual": [], "reviewed": []}))
    out = render(tmp_path)
    src = tmp_path / "normalized.mp4"
    t = max(doc["tracks"], key=lambda t: len(t["frames"]))
    x, y, w, h = t["frames"]["30"]
    a, b = _frame(src, 30)[y : y + h, x : x + w].astype(int), _frame(out, 30)[y : y + h, x : x + w].astype(int)
    assert np.abs(a - b).mean() < 3  # only codec noise


def test_missing_tracks_is_an_error(tmp_path):
    (tmp_path / "meta.json").write_text(json.dumps(
        {"fps": 30, "width": 64, "height": 64, "frameCount": 1, "durationSec": 0.03, "hasAudio": False}))
    with pytest.raises(Exception):
        render(tmp_path)
