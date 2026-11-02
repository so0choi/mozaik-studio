import json

import cv2
import numpy as np
import pytest

from helpers import make_video, moving_face_frames
from mosaic_worker import jobs
from mosaic_worker.detect import FaceDetector
from mosaic_worker.normalize import probe
from mosaic_worker import effects as fx
from mosaic_worker.render import compose_frame, pixelate, render
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


# ---- effects and composition ----

def _eff(t="mosaic", s=1, color="#000000"):
    return {"type": t, "strength": s, "color": color}


def _reg(box, effect, shape="rect", points=None, block=8, rid="r"):
    return {"id": rid, "shape": shape, "box": list(box), "points": points, "effect": effect, "block": block}


def _noise(h=120, w=160, seed=0):
    return np.random.default_rng(seed).integers(0, 256, (h, w, 3), dtype=np.uint8)


def _lap_var(img):
    return cv2.Laplacian(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()


def test_rect_mask_covers_whole_box_and_outside_untouched():
    src = _noise()
    out = compose_frame(src, [_reg((13, 17, 50, 43), _eff("color", color="#ff0000"))], None, lambda m: None)
    assert (out[17:60, 13:63] == (0, 0, 255)).all()
    m = np.ones(src.shape[:2], bool)
    m[17:60, 13:63] = False
    assert (out[m] == src[m]).all()
    assert out is not src


def test_color_effect_fills_exact_color_inside_mask_only():
    src = _noise()
    out = src.copy()
    region = _reg((20, 20, 41, 31), _eff("color", color="#1a2b3c"), shape="ellipse")
    fx.apply_region(src, out, region)
    mask = fx.shape_mask(region, 160, 120)
    inside = np.zeros(src.shape[:2], bool)
    inside[mask[0], mask[1]] = mask[2]
    assert (out[inside] == (0x3C, 0x2B, 0x1A)).all()
    assert (out[~inside] == src[~inside]).all()
    assert inside.sum() < 41 * 31


def test_blur_floor_removes_detail(face_image):
    face = cv2.resize(face_image, (200, 200))
    frame = np.full((300, 300, 3), 90, np.uint8)
    frame[50:250, 50:250] = face
    out = compose_frame(frame, [_reg((50, 50, 200, 200), _eff("blur", 1))], None, lambda m: None)
    ratio = _lap_var(out[50:250, 50:250]) / _lap_var(frame[50:250, 50:250])
    print("laplacian ratio", ratio)
    assert ratio < 0.02


def test_mosaic_strength_scales_block():
    src = _noise()
    box = (13, 17, 50, 43)
    out = compose_frame(src, [_reg(box, _eff("mosaic", 3), block=fx.region_block(8, 3))], None, lambda m: None)
    assert fx.region_block(8, 3) == 16
    assert _cells_uniform(out, 13, 17, 50, 43, 16)
    assert (out[17, 13 + 8] == out[17, 13]).all() and not (out[17, 13 + 16] == out[17, 13]).all()  # 16px cells, not 8


def test_background_then_regions_from_src():
    src = _noise()
    out = compose_frame(src, [_reg((20, 20, 40, 40), _eff("color", color="#ff0000"))], _eff("color", color="#0000ff"), lambda m: None)
    assert (out[20:60, 20:60] == (0, 0, 255)).all()
    assert (out[0:10, 0:10] == (255, 0, 0)).all()
    # a blur region reads src, not the (blue) background
    out2 = compose_frame(src, [_reg((20, 20, 40, 40), _eff("blur", 1))], _eff("color", color="#0000ff"), lambda m: None)
    centre = out2[30:50, 30:50].astype(int)
    assert centre.std() > 1 and not (out2[30:50, 30:50] == (255, 0, 0)).all()
    assert abs(centre.mean() - src[10:70, 10:70].mean()) < 25  # average of src noise, nothing like blue


def test_visible_face_gets_background():
    # a visible face has no region; the background effect must still cover it
    src = _noise()
    out = compose_frame(src, [], _eff("color", color="#00ff00"), lambda m: None)
    assert (out == (0, 255, 0)).all()
    mos = compose_frame(src, [], _eff("mosaic", 1), lambda m: None)
    assert _cells_uniform(mos, 0, 0, 160, 120, fx.background_block(160, 120, 1))
    bl = compose_frame(src, [], _eff("blur", 1), lambda m: None)
    assert _lap_var(bl) < _lap_var(src) * 0.1


def test_region_error_paints_black(monkeypatch):
    src = _noise() + 1  # never zero by chance
    src[src == 0] = 1
    real = fx.apply_region
    calls = []

    def boom(s, o, r):
        if r["id"] == "bad":
            raise RuntimeError("boom")
        real(s, o, r)

    monkeypatch.setattr("mosaic_worker.render.apply_region", boom)
    logs = []
    regions = [_reg((-5, 10, 40, 40), _eff("color", color="#ff0000"), shape="ellipse", rid="bad"),
               _reg((100, 60, 30, 30), _eff("color", color="#ff0000"), rid="ok")]
    out = compose_frame(src, regions, None, logs.append)
    assert logs and "bad" in logs[0]
    assert (out[10:50, 0:35] == 0).all()  # frame-clipped box, shape ignored
    assert (out[60:90, 100:130] == (0, 0, 255)).all()


def test_failed_region_black_survives_overlap(monkeypatch):
    src = _noise() + 1
    src[src == 0] = 1
    real = fx.apply_region

    def boom(s, o, r):
        if r["id"] == "A":
            raise RuntimeError("boom")
        real(s, o, r)

    monkeypatch.setattr("mosaic_worker.render.apply_region", boom)
    regions = [_reg((20, 20, 40, 40), _eff(), rid="A"),
               _reg((40, 40, 40, 40), _eff("color", color="#ff0000"), rid="B")]
    out = compose_frame(src, regions, None, lambda m: None)
    assert (out[20:60, 20:60] == 0).all()  # includes the overlap with B
    assert (out[60:80, 60:80] == (0, 0, 255)).all()


def test_shape_mask_error_also_fails_region_to_black(monkeypatch):
    src = _noise() + 1
    src[src == 0] = 1
    monkeypatch.setattr(fx, "shape_mask", lambda *a: (_ for _ in ()).throw(RuntimeError("x")))
    out = compose_frame(src, [_reg((10, 10, 20, 20), _eff("color", color="#ff0000"))], None, lambda m: None)
    assert (out[10:30, 10:30] == 0).all()


def test_background_error_fails_render(tmp_path, face_image, model_path, monkeypatch):
    _setup_job(tmp_path, face_image, model_path, False)
    (tmp_path / "edits.json").write_text(json.dumps(
        {"version": 1, "visible": [], "groups": [], "splits": [], "manual": [], "reviewed": [],
         "effects": {"default": _eff(), "background": _eff("blur", 1), "overrides": {}}}))

    def boom(*a):
        raise RuntimeError("bg")

    monkeypatch.setattr("mosaic_worker.render.apply_background", boom)
    with pytest.raises(UserFacingError):
        render(tmp_path)
    assert not (tmp_path / "output.mp4").exists()
    assert not (tmp_path / "output.tmp.mp4").exists()


def test_render_end_to_end_with_effects(tmp_path, face_image, model_path):
    doc = _setup_job(tmp_path, face_image, model_path, False)
    t = max(doc["tracks"], key=lambda t: len(t["frames"]))
    (tmp_path / "edits.json").write_text(json.dumps(
        {"version": 1, "visible": [], "groups": [], "splits": [], "manual": [], "reviewed": [],
         "effects": {"default": _eff("color", 1, "#ff0000"), "background": None, "overrides": {}}}))
    # make every track an ellipse via a manual-free path: ellipse only applies to manual regions,
    # so check the colour effect and an ellipse manual region separately below.
    out = render(tmp_path)
    src = tmp_path / "normalized.mp4"
    x, y, w, h = t["frames"]["30"]
    o = _frame(out, 30)[y : y + h, x : x + w].astype(int)
    assert np.abs(o - np.array([0, 0, 255])).mean() < 12  # red fill (codec noise tolerated)

    # an ellipse manual region: box corners (outside the ellipse) stay equal to the source
    mx, my, mw, mh = 20, 20, 120, 90
    (tmp_path / "manual").mkdir(exist_ok=True)
    frames = {str(f): [mx, my, mw, mh] for f in range(60)}
    (tmp_path / "manual" / "m1.json").write_text(json.dumps({"id": "m1", "frames": frames}))
    (tmp_path / "edits.json").write_text(json.dumps(
        {"version": 1, "visible": [t_["id"] for t_ in doc["tracks"]], "groups": [], "splits": [], "reviewed": [],
         "manual": [{"id": "m1", "shape": "ellipse", "anchors": [{"frame": 0, "box": [mx, my, mw, mh]}]}],
         "effects": {"default": _eff("color", 1, "#00ff00"), "background": None, "overrides": {}}}))
    out = render(tmp_path)
    s30, o30 = _frame(src, 30).astype(int), _frame(out, 30).astype(int)
    corner = (slice(my, my + 6), slice(mx, mx + 6))
    assert np.abs(s30[corner] - o30[corner]).mean() < 3
    cx, cy = mx + mw // 2, my + mh // 2
    assert np.abs(o30[cy - 5 : cy + 5, cx - 5 : cx + 5] - np.array([0, 255, 0])).mean() < 12


def test_reduced_res_blur_not_weaker_than_full_res(face_image):
    face = cv2.resize(face_image, (200, 200))
    frame = np.full((300, 300, 3), 90, np.uint8)
    frame[50:250, 50:250] = face
    region = _reg((50, 50, 200, 200), _eff("blur", 1))
    out = frame.copy()
    fx.apply_region(frame, out, region)
    sigma = fx.region_sigma(200, 200, 1)
    m = int(np.ceil(3 * sigma))
    y0, y1, x0, x1 = max(0, 50 - m), min(300, 250 + m), max(0, 50 - m), min(300, 250 + m)
    full = cv2.GaussianBlur(frame[y0:y1, x0:x1], (0, 0), sigmaX=sigma, borderType=cv2.BORDER_REPLICATE)
    full = full[50 - y0 : 250 - y0, 50 - x0 : 250 - x0]
    new_v, full_v = _lap_var(out[50:250, 50:250]), _lap_var(full)
    print("laplacian new", new_v, "full", full_v)
    assert new_v <= 1.5 * full_v + 1e-6


@pytest.mark.parametrize("box", [(-20, -15, 60, 50), (130, 90, 60, 50), (-10, 40, 40, 30)])
@pytest.mark.parametrize("shape", ["rect", "ellipse"])
def test_blur_region_partially_outside_frame_fills_mask(box, shape):
    src = np.full((120, 160, 3), 200, np.uint8)
    out = np.zeros_like(src)
    region = _reg(box, _eff("blur", 1), shape=shape)
    fx.apply_region(src, out, region)
    rows, cols, mask = fx.shape_mask(region, 160, 120)
    inside = np.zeros(src.shape[:2], bool)
    inside[rows, cols] = mask
    assert inside.any()
    assert (out[inside] == 200).all()
    assert (out[~inside] == 0).all()
