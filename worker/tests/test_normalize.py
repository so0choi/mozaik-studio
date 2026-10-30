import json

import cv2
import numpy as np
import pytest

from helpers import background, make_video
from mosaic_worker import normalize as nz
from mosaic_worker.status import UserFacingError


def _frames(n, w=320, h=180):
    out = []
    for i in range(n):
        f = background(w, h)
        cv2.rectangle(f, (10 + i, 40), (60 + i, 90), (0, 0, 255), -1)
        out.append(f)
    return out


def test_vfr_offset_audio_normalizes_to_cfr_pts0(tmp_path):
    src = make_video(tmp_path / "original.mkv", _frames(90), fps=29.97, with_audio=True, start_offset=0.5)
    assert nz.probe(src).start > 0.4  # input really has a non-zero start
    meta = nz.normalize(src, tmp_path)
    assert meta.fps == 30
    assert meta.has_audio is True
    out = tmp_path / "normalized.mp4"
    assert out.exists()
    info = nz.probe(out)
    assert info.start == pytest.approx(0.0, abs=1e-3)  # first packet PTS 0
    assert info.has_audio is True
    assert abs(meta.frame_count - round(meta.duration_sec * meta.fps)) <= 1
    assert abs(meta.frame_count - 90) <= 1
    saved = json.loads((tmp_path / "meta.json").read_text())
    assert saved == {
        "fps": 30, "width": 320, "height": 180, "frameCount": meta.frame_count,
        "durationSec": meta.duration_sec, "hasAudio": True,
    }


def test_no_audio_input(tmp_path):
    src = make_video(tmp_path / "original.mp4", _frames(30), fps=30)
    meta = nz.normalize(src, tmp_path)
    assert meta.has_audio is False
    assert (tmp_path / "normalized.mp4").exists()
    assert nz.probe(tmp_path / "normalized.mp4").has_audio is False


def test_too_long_raises_user_facing_error(tmp_path, monkeypatch):
    src = make_video(tmp_path / "original.mp4", _frames(10), fps=30)
    monkeypatch.setattr(nz, "probe", lambda p: nz.ProbeInfo(31 * 60, 0.0, 640, 360, 30.0, False))
    with pytest.raises(UserFacingError, match="30분 이하, 4K 이하 영상만 지원합니다."):
        nz.normalize(src, tmp_path)


def test_too_large_resolution_raises(tmp_path, monkeypatch):
    src = make_video(tmp_path / "original.mp4", _frames(10), fps=30)
    monkeypatch.setattr(nz, "probe", lambda p: nz.ProbeInfo(10, 0.0, 4096, 2304, 30.0, False))
    with pytest.raises(UserFacingError, match="4K"):
        nz.normalize(src, tmp_path)


def test_garbage_input_raises_user_facing_error(tmp_path):
    src = tmp_path / "original.mp4"
    src.write_bytes(b"not a video at all")
    with pytest.raises(UserFacingError, match="영상을 변환하지 못했습니다. 다른 파일로 다시 시도해 주세요."):
        nz.normalize(src, tmp_path)


def test_parse_probe_variants():
    s = (
        "Input #0, mov,mp4, from 'a.mp4':\n  Duration: 00:01:02.50, start: 0.500000, bitrate: 1000 kb/s\n"
        "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps, 29.97 tbr, 30k tbn\n"
        "  Stream #0:1[0x2](und): Audio: aac (LC), 44100 Hz, stereo, fltp\n"
    )
    p = nz.parse_probe(s)
    assert (p.width, p.height, p.has_audio) == (1920, 1080, True)
    assert p.fps == pytest.approx(29.97)
    assert p.duration == pytest.approx(62.5) and p.start == pytest.approx(0.5)


def _keyframe_count(path):
    import re
    import subprocess

    proc = subprocess.run(
        [nz.ffmpeg_bin(), "-hide_banner", "-skip_frame", "nokey", "-i", str(path), "-fps_mode", "passthrough", "-f", "null", "-"],
        capture_output=True, text=True, errors="replace",
    )
    return int(re.findall(r"frame=\s*(\d+)", proc.stderr)[-1])


def test_normalized_video_has_a_keyframe_every_second(tmp_path):
    # the studio seeks a lot; sparse keyframes (x264 default: 250 frames) make every seek decode seconds of video
    src = make_video(tmp_path / "original.mp4", _frames(90), fps=30)
    nz.normalize(src, tmp_path)
    assert _keyframe_count(tmp_path / "normalized.mp4") >= 3  # 0s, 1s, 2s
