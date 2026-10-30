"""Render output.mp4: pixelate mask boxes, pipe raw frames into ffmpeg, copy audio (spec 4.5)."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from .compose import mask_boxes
from .normalize import ffmpeg_bin, load_meta
from .status import MSG_RENDER_FAILED, UserFacingError


def pixelate(frame: np.ndarray, box, block: int) -> None:
    """Pixelate `box` in place on a block x block grid whose origin is the box top-left."""
    x, y, w, h = (int(v) for v in box[:4])
    fh, fw = frame.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(fw, x + w), min(fh, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    # grid origin stays at the (unclamped) box corner
    ox, oy = x0 - x, y0 - y
    rw, rh = x1 - x0, y1 - y0
    cols = -(-(ox + rw) // block)
    rows = -(-(oy + rh) // block)
    region = frame[y0:y1, x0:x1]
    padded = cv2.copyMakeBorder(region, oy, rows * block - oy - rh, ox, cols * block - ox - rw, cv2.BORDER_REPLICATE)
    small = cv2.resize(padded, (cols, rows), interpolation=cv2.INTER_AREA)
    big = cv2.resize(small, (cols * block, rows * block), interpolation=cv2.INTER_NEAREST)
    frame[y0:y1, x0:x1] = big[oy : oy + rh, ox : ox + rw]


def _read_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def load_inputs(job_dir: Path):
    tracks_doc = json.loads((job_dir / "tracks.json").read_text(encoding="utf-8"))
    edits = _read_json(job_dir / "edits.json", {"version": 1, "visible": [], "groups": [], "splits": [], "manual": [], "reviewed": []})
    manual = [json.loads(p.read_text(encoding="utf-8")) for p in sorted((job_dir / "manual").glob("*.json"))]
    return tracks_doc, edits, manual


def render(job_dir: Path, progress: Callable[[str, int], None] | None = None) -> Path:
    job_dir = Path(job_dir)
    meta = load_meta(job_dir)
    tracks_doc, edits, manual = load_inputs(job_dir)
    boxes = mask_boxes(tracks_doc, edits, manual)
    src = job_dir / "normalized.mp4"
    out = job_dir / "output.mp4"
    tmp = job_dir / "output.tmp.mp4"
    log_path = job_dir / "render.log"

    cmd = [
        ffmpeg_bin(), "-hide_banner", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{meta.width}x{meta.height}", "-r", str(meta.fps), "-i", "-",
    ]
    if meta.has_audio:
        cmd += ["-i", str(src), "-map", "0:v", "-map", "1:a", "-c:a", "copy", "-shortest"]
    cmd += [
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-bf", "0", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-f", "mp4", str(tmp),
    ]

    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise UserFacingError(MSG_RENDER_FAILED)
    written = 0
    last_pct = -1
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=log)
        try:
            idx = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                for x, y, w, h, block in boxes.get(idx, ()):
                    pixelate(frame, (x, y, w, h), block)
                proc.stdin.write(np.ascontiguousarray(frame).tobytes())
                idx += 1
                written = idx
                if progress:
                    pct = min(99, int(idx * 100 / max(1, meta.frame_count)))
                    if pct != last_pct:
                        last_pct = pct
                        progress("rendering", pct)
        except BrokenPipeError:
            pass
        finally:
            cap.release()
            try:
                proc.stdin.close()
            except BrokenPipeError:
                pass
        rc = proc.wait()
    if rc != 0 or written == 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise UserFacingError(MSG_RENDER_FAILED)
    os.replace(tmp, out)
    log_path.unlink(missing_ok=True)
    if progress:
        progress("rendering", 100)
    return out
