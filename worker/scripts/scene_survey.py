"""Debug only: per-frame scene-cut metrics for a whole video, plus prev|cur thumbnails of the frames that pass
the histogram tests (so a human can tell real cuts from lighting changes). Not used by the worker.

  python scripts/scene_survey.py VIDEO --out OUT [--min-hist 0.25]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mosaic_worker import scenecut as SC  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-hist", type=float, default=SC.CUT_MIN_DISTANCE)
    a = ap.parse_args()
    out = Path(a.out)
    (out / "pairs").mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(a.video)
    fps = int(round(cap.get(cv2.CAP_PROP_FPS)))
    sc = SC.SceneCuts(fps)
    prev = prev_gray = prev_small = None
    rows, thumbs = [], {}
    idx = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        sc.observe(idx, frame)
        small = cv2.resize(frame, (64, 64))
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        thumb = cv2.resize(frame, (320, 180))
        if prev is not None:
            d = float(cv2.compareHist(prev, hist, cv2.HISTCMP_BHATTACHARYYA))
            g = float(np.abs(gray - prev_gray).mean())
            rows.append([idx, d, g])
            if d >= a.min_hist:
                thumbs[idx] = (prev_small, thumb)
        prev, prev_gray, prev_small = hist, gray, thumb
        idx += 1
    sc.finish()
    w = sc.w
    dist = {r[0]: r[1] for r in rows}
    cands = []
    for f, d, g in rows:
        if d < a.min_hist:
            continue
        near = [dist[i] for i in range(f - w, f + w + 1) if i != f and i in dist]
        med = float(np.median(near)) if near else 0.0
        ratio = d / med if med else float("inf")
        cands.append({"frame": f, "t": round(f / fps, 2), "hist": round(d, 3), "gray": round(g, 1),
                      "ratio": round(ratio, 2), "cut": f in sc.cuts})
        if ratio >= SC.CUT_RATIO:
            p, c = thumbs[f]
            im = np.hstack([p, c])
            cv2.putText(im, f"f{f} h{d:.2f} g{g:.1f} r{ratio:.1f} {'CUT' if f in sc.cuts else 'no'}", (5, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)
            cv2.imwrite(str(out / "pairs" / f"f{f:06d}.jpg"), im)
    (out / "survey.json").write_text(json.dumps({"video": a.video, "fps": fps, "frames": idx, "w": w,
                                                 "cuts": sorted(sc.cuts), "candidates": cands}, indent=1))
    print(json.dumps({"frames": idx, "cuts": sorted(sc.cuts),
                      "ratio_pass_gray_fail": [c for c in cands if c["ratio"] >= SC.CUT_RATIO and not c["cut"]]}))


if __name__ == "__main__":
    main()
