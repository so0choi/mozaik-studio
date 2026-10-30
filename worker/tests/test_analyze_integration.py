import json

import cv2

from helpers import background, make_video, moving_face_frames
from mosaic_worker import jobs
from mosaic_worker.detect import FaceDetector
from mosaic_worker.normalize import normalize


def test_moving_face_is_tracked(tmp_path, face_image, model_path):
    frames, pos = moving_face_frames(face_image, n=90)
    src = make_video(tmp_path / "original.mp4", frames, fps=30, with_audio=True)
    meta = normalize(src, tmp_path)
    seen = []
    jobs.analyze(tmp_path, lambda s, p: seen.append((s, p)), detector=FaceDetector(model_path), meta=meta)

    doc = json.loads((tmp_path / "tracks.json").read_text())
    assert doc["version"] == 1 and doc["frameCount"] == meta.frame_count
    assert len(doc["tracks"]) >= 1
    covered = set()
    for t in doc["tracks"]:
        covered |= {int(f) for f in t["frames"]}
        assert (tmp_path / t["thumb"]).exists()
        assert all((tmp_path / s).exists() for s in t["samples"])
        assert t["blockSize"] >= 8
        assert t["segments"]
    assert len(covered) / meta.frame_count >= 0.9
    assert json.loads((tmp_path / "review.json").read_text())["items"] is not None
    assert seen and seen[-1] == ("analyzing", 100)
    assert [p for _, p in seen] == sorted(p for _, p in seen)  # progress never goes backwards

    # boxes land on the face (expanded 25% so center stays)
    t = max(doc["tracks"], key=lambda t: len(t["frames"]))
    f = 45
    x, y, w, h = t["frames"][str(f)]
    px, py, size = pos[f]
    assert abs((x + w / 2) - (px + size / 2)) < size * 0.3
    assert abs((y + h / 2) - (py + size / 2)) < size * 0.3
    thumb = cv2.imread(str(tmp_path / t["thumb"]))
    assert thumb.shape[1] == 160


def test_empty_background_has_no_tracks(tmp_path, model_path):
    frames = [background() for _ in range(30)]
    src = make_video(tmp_path / "original.mp4", frames, fps=30)
    jobs.run_analyze(tmp_path, lambda s, p: None, detector=FaceDetector(model_path))
    doc = json.loads((tmp_path / "tracks.json").read_text())
    assert doc["tracks"] == []
    assert json.loads((tmp_path / "review.json").read_text()) == {"items": []}
    assert (tmp_path / "meta.json").exists()


def test_run_analyze_reports_states(tmp_path, face_image, model_path):
    frames, _ = moving_face_frames(face_image, n=20)
    make_video(tmp_path / "original.mp4", frames, fps=30)
    states = []
    jobs.run_analyze(tmp_path, lambda s, p: states.append(s), detector=FaceDetector(model_path))
    assert states[0] == "normalizing" and "analyzing" in states
