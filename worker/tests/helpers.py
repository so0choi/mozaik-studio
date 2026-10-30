"""Shared test helpers: synthetic videos built with cv2 + ffmpeg."""
from __future__ import annotations

import subprocess
from pathlib import Path

import cv2
import numpy as np

from mosaic_worker.normalize import ffmpeg_bin

FIXTURES = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"


def make_video(path: Path, frames, fps: float, with_audio: bool = False, start_offset: float = 0.0) -> Path:
    """Encode an iterable of BGR frames to `path` (H.264). Optional sine audio and start offset."""
    path = Path(path)
    frames = list(frames)
    h, w = frames[0].shape[:2]
    raw = path.with_name(path.stem + "_raw.mp4")
    vw = cv2.VideoWriter(str(raw), cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    for f in frames:
        vw.write(f)
    vw.release()
    dur = len(frames) / fps
    cmd = [ffmpeg_bin(), "-hide_banner", "-y"]
    cmd += ["-i", str(raw)]
    if with_audio:
        cmd += ["-f", "lavfi", "-t", f"{dur:.3f}", "-i", "sine=frequency=440:sample_rate=44100"]
    cmd += ["-map", "0:v"]
    if with_audio:
        cmd += ["-map", "1:a", "-c:a", "aac", "-b:a", "96k", "-shortest"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18"]
    if start_offset:  # shifts every stream's timestamps; use a .mkv path so the offset survives muxing
        cmd += ["-output_ts_offset", str(start_offset)]
    cmd += [str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    raw.unlink()
    return path


def background(w: int = 640, h: int = 360) -> np.ndarray:
    bg = np.full((h, w, 3), 90, np.uint8)
    bg[:, :, 1] += np.linspace(0, 40, w, dtype=np.uint8)[None, :]
    return bg


def moving_face_frames(face: np.ndarray, n: int = 90, w: int = 640, h: int = 360, size: int = 200):
    """Face moving left to right at constant speed; also returns per-frame (x, y, size)."""
    face = cv2.resize(face, (size, size))
    frames, pos = [], []
    for i in range(n):
        f = background(w, h)
        x = int(20 + (w - size - 40) * i / max(1, n - 1))
        y = (h - size) // 2
        f[y : y + size, x : x + size] = face
        frames.append(f)
        pos.append((x, y, size))
    return frames, pos


def has_audio(path: Path) -> bool:
    from mosaic_worker.normalize import probe

    return probe(path).has_audio
