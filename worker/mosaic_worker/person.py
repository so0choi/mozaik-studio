"""Person-gate: is a face-detector hit sitting where a person's head would be?

YuNet occasionally fires on food, hands and textures. TrackVerifier (verify.py) flags such
tracks as `suspect` with a crop re-check, but on its own that is only a hint. This module adds
an independent second signal: a NanoDet person detector (OpenCV zoo, Apache 2.0, CPU) run on
every N-th frame, N = max(1, round(fps / 2)). A face detection is "supported" if its centre lies
inside some person box (expanded by BOX_MARGIN on each side horizontally) and within the top
HEAD_FRACTION of that expanded box. Per track: any supported detection -> `support`; judged
against person boxes but never supported -> `no_support`; never had a person box nearby ->
`unknown`. `unknown` is never treated as a non-face.

A track that is suspect AND `no_support` is flagged `nonface` in tracks.json: "likely not a face",
unmasked by default at the end of analysis (product owner's call, 2026-11-05). Known risk: on a
crowded street vlog 8 of 100 sampled such tracks were real faces (close-ups filling the frame, small
crowd faces); the reviewer can re-mask them from the "may not be a face" group. Measured on ONE
video (139 hand-labelled tracks): 0 of 43 real faces lost, 47 of 90 non-faces caught, about
19 ms per sampled frame on CPU. It is a single video, so treat the numbers as a first estimate.

Each face detection is judged against the person frame nearest to it in time (within N/2), so
detections that precede the next sampled frame are buffered until it is available.
If the model is missing or fails, every track stays `unknown` and nothing is flagged.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Callable

import cv2
import numpy as np

from .detect import Detection

log = logging.getLogger(__name__)

PERSON_MODEL_FILE = "object_detection_nanodet_2022nov.onnx"
PERSON_MIN_SCORE = 0.35
HEAD_FRACTION = 0.25  # face centre must be in the top 25% of the (expanded) person box
BOX_MARGIN = 0.10  # person box grows by 10% of its size, split over both sides

INPUT_SIZE = 416
STRIDES = (8, 16, 32, 64)
REG_MAX = 7  # 8 distribution bins per box side
NMS_IOU = 0.6
_MEAN = np.array([103.53, 116.28, 123.675], np.float32)  # BGR
_STD = np.array([57.375, 57.12, 58.395], np.float32)

PersonBox = tuple  # (x, y, w, h, score) in frame pixels
DetectFn = Callable[[np.ndarray], list]


def default_person_model_path() -> Path:
    env = os.environ.get("PERSON_MODEL_PATH")
    if env:
        return Path(env)
    return Path(__file__).resolve().parents[1] / "models" / PERSON_MODEL_FILE


def _softmax(x: np.ndarray) -> np.ndarray:
    e = np.exp(x - x.max(-1, keepdims=True))
    return e / e.sum(-1, keepdims=True)


class PersonDetector:
    """NanoDet-Plus (416 input, class 0 = person). Model is loaded on first use."""

    def __init__(self, model_path: Path | None = None):
        self._path = Path(model_path) if model_path else default_person_model_path()
        self._net = None

    def _load(self):
        if self._net is None:
            if not self._path.exists():
                raise FileNotFoundError(f"person model not found: {self._path} (run scripts/fetch_model.sh)")
            self._net = cv2.dnn.readNet(str(self._path))
        return self._net

    def detect(self, frame: np.ndarray, min_score: float = PERSON_MIN_SCORE) -> list[PersonBox]:
        net = self._load()
        h, w = frame.shape[:2]
        r = INPUT_SIZE / max(h, w)
        nh, nw = int(round(h * r)), int(round(w * r))
        px, py = (INPUT_SIZE - nw) // 2, (INPUT_SIZE - nh) // 2
        canvas = np.zeros((INPUT_SIZE, INPUT_SIZE, 3), np.uint8)  # zero padding (letterbox)
        canvas[py : py + nh, px : px + nw] = cv2.resize(frame, (nw, nh))
        blob = ((canvas.astype(np.float32) - _MEAN) / _STD).transpose(2, 0, 1)[None]
        net.setInput(blob)
        outs = net.forward(net.getUnconnectedOutLayersNames())
        cls_outs, reg_outs = outs[0::2], outs[1::2]  # interleaved cls/reg per stride

        boxes: list[list[float]] = []
        scores: list[float] = []
        bins = np.arange(REG_MAX + 1, dtype=np.float32)
        for stride, cls, reg in zip(STRIDES, cls_outs, reg_outs):
            cls = cls.reshape(-1, cls.shape[-1])
            reg = reg.reshape(-1, 4 * (REG_MAX + 1))
            g = int(round(len(cls) ** 0.5))
            ys, xs = np.mgrid[0:g, 0:g]
            cx = (xs.ravel() * stride + 0.5 * (stride - 1)).astype(np.float32)
            cy = (ys.ravel() * stride + 0.5 * (stride - 1)).astype(np.float32)
            p = cls[:, 0]
            keep = np.where(p > min_score)[0]
            if not len(keep):
                continue
            d = _softmax(reg[keep].reshape(-1, 4, REG_MAX + 1)) @ bins * stride
            x1, y1 = cx[keep] - d[:, 0], cy[keep] - d[:, 1]
            x2, y2 = cx[keep] + d[:, 2], cy[keep] + d[:, 3]
            for a, b, c, e, s in zip(x1, y1, x2, y2, p[keep]):
                boxes.append([float((a - px) / r), float((b - py) / r), float((c - a) / r), float((e - b) / r)])
                scores.append(float(s))
        if not boxes:
            return []
        idx = np.array(cv2.dnn.NMSBoxes(boxes, scores, min_score, NMS_IOU)).ravel()
        return [(boxes[i][0], boxes[i][1], boxes[i][2], boxes[i][3], scores[i]) for i in idx]

    __call__ = detect


def head_supported(face_box, person_boxes) -> bool:
    """True if the face centre is in the head zone of any person box (x, y, w, h[, score])."""
    x, y, w, h = face_box[:4]
    cx, cy = x + w / 2, y + h / 2
    for pb in person_boxes:
        px, py, pw, ph = pb[:4]
        ex, ey = px - BOX_MARGIN * pw / 2, py - BOX_MARGIN * ph / 2
        ew, eh = pw * (1 + BOX_MARGIN), ph * (1 + BOX_MARGIN)
        if ex <= cx <= ex + ew and ey <= cy <= ey + HEAD_FRACTION * eh:
            return True
    return False


class PersonGate:
    """Feed it every frame of the decoding pass; read `state(track_id)` afterwards.

    Track ids are the tracker's pre-link ids (the same ones TrackVerifier sees).
    """

    def __init__(self, fps: float, detector: DetectFn | None = None):
        self.step = max(1, round(fps / 2))
        self._half = self.step / 2
        self._detector = detector
        self._disabled = False
        self._last: tuple[int, list] | None = None  # (frame idx, person boxes)
        self._buffer: list[tuple[int, str, Detection]] = []
        self._supported: set[str] = set()
        self._judged: set[str] = set()  # judged against a frame that had person boxes

    def _disable(self, why: str) -> None:
        if not self._disabled:
            log.warning("person model unavailable (%s); person check skipped, all tracks stay unknown", why)
        self._disabled = True
        self._buffer.clear()

    def _run_detector(self, frame: np.ndarray) -> list | None:
        try:
            if self._detector is None:
                path = default_person_model_path()
                if not path.exists():
                    raise FileNotFoundError(path)
                self._detector = PersonDetector(path)
            boxes = self._detector(frame)
        except Exception as e:  # noqa: BLE001 - never let the optional check break analysis
            self._disable(f"{type(e).__name__}: {e}")
            return None
        return [b for b in boxes if b[4] >= PERSON_MIN_SCORE]

    def _judge(self, tid: str, det: Detection, persons: list) -> None:
        if not persons:
            return
        self._judged.add(tid)
        if head_supported(det.box, persons):
            self._supported.add(tid)

    def observe(self, idx: int, frame: np.ndarray, assigned: dict[str, Detection]) -> None:
        if self._disabled:
            return
        if idx % self.step == 0:
            persons = self._run_detector(frame)
            if persons is None:
                return
            # buffered detections are nearer to this frame than to the previous one
            for _, tid, det in self._buffer:
                self._judge(tid, det, persons)
            self._buffer.clear()
            self._last = (idx, persons)
            for tid, det in assigned.items():
                self._judge(tid, det, persons)
            return
        for tid, det in assigned.items():
            if self._last is not None and idx - self._last[0] <= self._half:
                self._judge(tid, det, self._last[1])
            else:
                self._buffer.append((idx, tid, det))

    def finish(self) -> None:
        """Detections after the last person frame: judge if close enough to it, else drop them."""
        if self._last is not None and not self._disabled:
            last_idx, persons = self._last
            for i, tid, det in self._buffer:
                if i - last_idx <= self._half:
                    self._judge(tid, det, persons)
        self._buffer.clear()

    def state(self, track_id: str) -> str:
        if self._disabled:
            return "unknown"  # a check that stopped half-way is not evidence
        if track_id in self._supported:
            return "support"
        if track_id in self._judged:
            return "no_support"
        return "unknown"
