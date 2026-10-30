"""Step 1: normalize an upload to CFR H.264/AAC with PTS starting at 0 (spec 4.1)."""
from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, asdict
from pathlib import Path

import cv2

from .status import MSG_CONVERT_FAILED, MSG_LIMIT, UserFacingError, atomic_write_json

MAX_DURATION_SEC = 30 * 60
MAX_LONG_SIDE = 3840
MAX_SHORT_SIDE = 2160


def ffmpeg_bin() -> str:
    env = os.environ.get("FFMPEG_BIN")
    if env:
        return env
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


@dataclass
class Meta:
    fps: int
    width: int
    height: int
    frame_count: int
    duration_sec: float
    has_audio: bool

    def to_json(self) -> dict:
        return {
            "fps": self.fps,
            "width": self.width,
            "height": self.height,
            "frameCount": self.frame_count,
            "durationSec": self.duration_sec,
            "hasAudio": self.has_audio,
        }


@dataclass
class ProbeInfo:
    duration: float
    start: float
    width: int
    height: int
    fps: float
    has_audio: bool


_DUR = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?),\s*start:\s*(-?\d+(?:\.\d+)?)")
_DUR_NA = re.compile(r"Duration:\s*N/A")
_VIDEO = re.compile(r"Stream #\d+:\d+[^:]*:\s*Video:.*")
_SIZE = re.compile(r"[\s,](\d{2,5})x(\d{2,5})[\s,\[]")
_FPS = re.compile(r"(\d+(?:\.\d+)?)\s*fps")
_TBR = re.compile(r"(\d+(?:\.\d+)?)\s*tbr")


def parse_probe(stderr: str) -> ProbeInfo:
    """Parse `ffmpeg -i file` stderr (ffprobe may not be installed)."""
    m = _DUR.search(stderr)
    duration, start = 0.0, 0.0
    if m:
        duration = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        start = float(m.group(4))
    video_line = None
    for line in stderr.splitlines():
        if _VIDEO.search(line) and "Video:" in line and "attached pic" not in line:
            video_line = line
            break
    if video_line is None:
        raise UserFacingError(MSG_CONVERT_FAILED)
    # drop the codec tag "(avc1 / 0x31637661)" so it is not read as a size
    body = video_line.split("Video:", 1)[1]
    sm = _SIZE.search(" " + re.sub(r"\([^)]*\)", "", body) + " ")
    if not sm:
        raise UserFacingError(MSG_CONVERT_FAILED)
    width, height = int(sm.group(1)), int(sm.group(2))
    fm = _FPS.search(body) or _TBR.search(body)
    fps = float(fm.group(1)) if fm else 30.0
    has_audio = bool(re.search(r"Stream #\d+:\d+[^:]*:\s*Audio:", stderr))
    return ProbeInfo(duration, start, width, height, fps, has_audio)


def probe(path: Path) -> ProbeInfo:
    proc = subprocess.run([ffmpeg_bin(), "-hide_banner", "-i", str(path)], capture_output=True, text=True, errors="replace")
    return parse_probe(proc.stderr)


def normalize(src: Path, job_dir: Path) -> Meta:
    src, job_dir = Path(src), Path(job_dir)
    try:
        info = probe(src)
    except UserFacingError:
        raise
    except Exception as e:  # noqa: BLE001
        raise UserFacingError(MSG_CONVERT_FAILED) from e

    if (
        info.duration > MAX_DURATION_SEC
        or max(info.width, info.height) > MAX_LONG_SIDE
        or min(info.width, info.height) > MAX_SHORT_SIDE
    ):
        raise UserFacingError(MSG_LIMIT)

    fps = max(1, round(info.fps))
    out = job_dir / "normalized.mp4"
    tmp = job_dir / "normalized.tmp.mp4"
    cmd = [
        ffmpeg_bin(), "-hide_banner", "-y", "-i", str(src),
        "-map", "0:v:0",
        *(["-map", "0:a:0"] if info.has_audio else []),
        "-vf", f"fps={fps},setpts=PTS-STARTPTS",
        *(["-af", "asetpts=PTS-STARTPTS"] if info.has_audio else []),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        # no B-frames: otherwise the mp4 edit list makes the first presentation time 0.04-0.07s, not 0
        "-bf", "0", "-pix_fmt", "yuv420p",
        *(["-c:a", "aac", "-b:a", "128k"] if info.has_audio else ["-an"]),
        "-avoid_negative_ts", "make_zero", "-movflags", "+faststart",
        "-f", "mp4", str(tmp),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if proc.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        raise UserFacingError(MSG_CONVERT_FAILED)
    os.replace(tmp, out)

    cap = cv2.VideoCapture(str(out))
    try:
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        frame_count = int(round(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    finally:
        cap.release()
    if width <= 0 or height <= 0 or frame_count <= 0:
        raise UserFacingError(MSG_CONVERT_FAILED)

    meta = Meta(fps, width, height, frame_count, round(frame_count / fps, 3), info.has_audio)
    atomic_write_json(job_dir / "meta.json", meta.to_json())
    return meta


def load_meta(job_dir: Path) -> Meta:
    d = json.loads((Path(job_dir) / "meta.json").read_text(encoding="utf-8"))
    return Meta(d["fps"], d["width"], d["height"], d["frameCount"], d["durationSec"], d["hasAudio"])


def find_original(job_dir: Path) -> Path:
    cands = sorted(p for p in Path(job_dir).glob("original.*") if p.is_file())
    if not cands:
        raise UserFacingError(MSG_CONVERT_FAILED)
    return cands[0]
