"""Render output.mp4: pixelate mask boxes, pipe raw frames into ffmpeg, copy audio (spec 4.5)."""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from .compose import mask_regions
from .effects import apply_background, apply_region, normalize_effects, pixelate  # noqa: F401  (pixelate re-exported)
from .normalize import ffmpeg_bin, load_meta
from .status import MSG_RENDER_FAILED, UserFacingError


def compose_frame(src: np.ndarray, regions: list[dict], background: dict | None, log: Callable[[str], None],
                  logged: set | None = None) -> np.ndarray:
    """Spec 4.2 order: background over the whole frame, every region from the ORIGINAL src on top,
    then each failed region's frame-clipped box painted black (shape ignored). A background
    exception propagates (render fails); a region exception is logged and masked black.
    `logged` (a per-render set of region ids) makes each failing region log once, not once per frame."""
    if not regions and not background:
        return src  # nothing to mask: no copy (callers only read the result)
    out = apply_background(src, background) if background else src.copy()
    failed: list[list[int]] = []
    for r in regions:
        try:
            apply_region(src, out, r)
        except Exception as e:  # never leave a face exposed: black it out below
            rid = r.get("id")
            if logged is None or rid not in logged:
                if logged is not None:
                    logged.add(rid)
                log(f"region {rid} failed: {e!r}")
            failed.append(list(r["box"][:4]))
    fh, fw = out.shape[:2]
    for x, y, w, h in failed:
        out[max(0, int(y)) : max(0, min(fh, int(y) + int(h))), max(0, int(x)) : max(0, min(fw, int(x) + int(w)))] = 0
    return out


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
    regions = mask_regions(tracks_doc, edits, manual)
    background = normalize_effects(edits)["background"]
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
        "-g", str(meta.fps),  # same keyframe grid as normalized.mp4: fast seeking in the download too
        "-movflags", "+faststart", "-f", "mp4", str(tmp),
    ]

    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        raise UserFacingError(MSG_RENDER_FAILED)
    written = 0
    last_pct = -1
    logged_regions: set = set()
    failed = False
    with open(log_path, "wb") as log:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=log, stderr=log)
        try:
            idx = 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                try:
                    frame = compose_frame(frame, regions.get(idx, []), background, lambda m: log.write((m + "\n").encode()), logged_regions)
                except Exception as e:
                    log.write(f"frame {idx} failed: {e!r}\n".encode())
                    raise UserFacingError(MSG_RENDER_FAILED)
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
        except BaseException:
            failed = True  # any abort: reap ffmpeg and drop the partial output
            raise
        finally:
            cap.release()
            if failed:
                proc.kill()  # no more frames will come: do not let ffmpeg finish a truncated file
            try:
                proc.stdin.close()
            except (BrokenPipeError, OSError):
                pass
            if failed:
                proc.wait()
                tmp.unlink(missing_ok=True)
        rc = proc.wait()
    if rc != 0 or written == 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise UserFacingError(MSG_RENDER_FAILED)
    os.replace(tmp, out)
    log_path.unlink(missing_ok=True)
    if progress:
        progress("rendering", 100)
    return out
