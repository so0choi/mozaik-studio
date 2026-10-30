"""YuNet face detection (OpenCV FaceDetectorYN, CPU). Spec 4.2."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

SCORE_THRESHOLD = 0.5
NMS_THRESHOLD = 0.3
MAX_SHORT_SIDE = 1080
MODEL_FILE = "face_detection_yunet_2023mar.onnx"


def default_model_path() -> Path:
    env = os.environ.get("MODEL_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[1] / "models" / MODEL_FILE


@dataclass(frozen=True)
class Detection:
    box: tuple[int, int, int, int]  # x, y, w, h in original-frame pixels
    score: float


class FaceDetector:
    def __init__(self, model_path: Path | None = None):
        path = Path(model_path) if model_path else default_model_path()
        if not path.exists():
            raise FileNotFoundError(f"YuNet model not found: {path} (run scripts/fetch_model.sh)")
        self._det = cv2.FaceDetectorYN.create(
            str(path), "", (320, 320), SCORE_THRESHOLD, NMS_THRESHOLD, 5000
        )

    def detect(self, frame: np.ndarray) -> list[Detection]:
        h, w = frame.shape[:2]
        scale = 1.0
        img = frame
        short = min(h, w)
        if short > MAX_SHORT_SIDE:
            scale = MAX_SHORT_SIDE / short
            img = cv2.resize(frame, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
        ih, iw = img.shape[:2]
        self._det.setInputSize((iw, ih))
        _, faces = self._det.detect(img)
        out: list[Detection] = []
        if faces is None:
            return out
        for row in faces:
            x, y, bw, bh = (float(v) / scale for v in row[:4])
            x0, y0 = max(0, int(round(x))), max(0, int(round(y)))
            x1, y1 = min(w, int(round(x + bw))), min(h, int(round(y + bh)))
            if x1 - x0 < 1 or y1 - y0 < 1:
                continue
            out.append(Detection((x0, y0, x1 - x0, y1 - y0), float(row[-1])))
        return out
