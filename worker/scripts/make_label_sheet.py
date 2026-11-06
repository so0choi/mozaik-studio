"""Debug only: build a labeling sheet (items.json + images) for worker/scripts/label_server.py.

Three question types, answered by eye (no technical knowledge needed):
  cut   prev|cur frame pair: did the camera shot change?            -> checks SceneCuts
  box   one mask box (crop + whole frame): is there a face in it?   -> over-masking / correct masks
  miss  whole frame with the mask areas drawn: any face left bare?  -> exposure (clicked points)

Labels describe the video, not one pipeline run (a face region / a point / a cut frame), so the same answers can
score any later variant with scripts/score_labels.py. Where each box came from (real detection, hold, ...) is kept
in `meta` and never shown in the UI.

  python scripts/make_label_sheet.py --video V --tracks T.json --edits E.json --survey S.json --out SHEET \
      [--base-tracks B.json] [--title NAME] [--seed 7]
"""
from __future__ import annotations

import argparse
import json
import math
import random
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mosaic_worker.shapes import face_ellipse_box  # noqa: E402

YELLOW, MAGENTA = (0, 255, 255), (255, 0, 255)
# strata: (name, how many) — kept small so the whole sheet takes ~15 minutes
BOX_PLAN = [("real_high", 15), ("real_low", 25), ("held", 25), ("leading", 15), ("suspect", 20), ("removed_by_fix", 10)]
BIG_FACE = 30  # px, raw (unexpanded) median box width; "suspect_big" = suspect tracks a size-gated check would act on
N_MISS = 30
N_CUT_CONTROLS = 6  # cuts the current rule already finds clearly, as a sanity check of the labeler


def _finite(o):
    if isinstance(o, float) and not math.isfinite(o):
        return None
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_finite(v) for v in o]
    return o


def box_source(t: dict, f: int) -> str:
    sc = t["scores"]
    if str(f) in sc:
        return "real_high" if sc[str(f)] >= 0.75 else "real_low"
    reals = [int(k) for k in sc]
    return "leading" if reals and f < min(reals) else "held"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--tracks", required=True, help="tracks doc of the current pipeline (debug_stages --dump-tracks)")
    ap.add_argument("--base-tracks", help="tracks doc of the previous pipeline, to sample boxes the change removed")
    ap.add_argument("--edits", required=True)
    ap.add_argument("--survey", required=True, help="scene_survey.py survey.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--plan", help='JSON list of [stratum, count] to replace BOX_PLAN, e.g. [["suspect_big",30],["held",15]]')
    a = ap.parse_args()

    rng = random.Random(a.seed)
    doc = json.loads(Path(a.tracks).read_text())
    vis = set(json.loads(Path(a.edits).read_text()).get("visible") or [])
    W, H, fps, n = doc["width"], doc["height"], doc["fps"], doc["frameCount"]
    out = Path(a.out)
    (out / "img").mkdir(parents=True, exist_ok=True)

    # ---------------- box candidates
    plan = [tuple(x) for x in json.loads(a.plan)] if a.plan else BOX_PLAN
    pools: dict[str, list] = {k: [] for k, _ in plan}
    split_big = any(name == "suspect_big" for name, _ in plan)  # default plan keeps the original single suspect pool
    pools.setdefault("suspect", []); pools.setdefault("suspect_big", []); pools.setdefault("removed_by_fix", [])
    for k in ("real_high", "real_low", "held", "leading"):
        pools.setdefault(k, [])
    for t in doc["tracks"]:
        flagged = t.get("suspect") or t.get("nonface")
        real_w = sorted(t["frames"][f][2] / 1.25 for f in t["scores"] if f in t["frames"])
        big = bool(real_w) and real_w[len(real_w) // 2] >= BIG_FACE
        for fs, b in t["frames"].items():
            f = int(fs)
            src = box_source(t, f)
            cand = {"frame": f, "box": b, "track": t["id"], "source": src, "flagged": bool(flagged),
                    "visible": t["id"] in vis, "score": t["scores"].get(fs)}
            pools[("suspect_big" if big and split_big else "suspect") if flagged else src].append(cand)
    if a.base_tracks:
        base = json.loads(Path(a.base_tracks).read_text())
        now = {(t["id"], f) for t in doc["tracks"] for f in t["frames"]}
        for t in base["tracks"]:
            for fs, b in t["frames"].items():
                if (t["id"], fs) not in now and t["id"] not in vis:
                    pools["removed_by_fix"].append({"frame": int(fs), "box": b, "track": t["id"], "source": box_source(t, int(fs)),
                                                    "flagged": bool(t.get("suspect") or t.get("nonface")), "visible": False,
                                                    "score": t["scores"].get(fs)})

    picked: list[dict] = []
    per_track: dict[str, int] = {}
    for name, k in plan:
        pool = pools[name][:]
        rng.shuffle(pool)
        got = 0
        for c in pool:
            if got >= k:
                break
            key = c["track"] + ("-removed" if name == "removed_by_fix" else "")
            if per_track.get(key, 0) >= 2:
                continue  # at most two questions per track: spread over people and time
            if any(p["track"] == c["track"] and abs(p["frame"] - c["frame"]) < fps for p in picked):
                continue
            per_track[key] = per_track.get(key, 0) + 1
            picked.append({**c, "stratum": name})
            got += 1
    rng.shuffle(picked)

    # ---------------- miss frames: one random frame per equal time slice
    slice_len = n / N_MISS
    miss_frames = sorted({min(n - 1, int(i * slice_len + rng.random() * slice_len)) for i in range(N_MISS)})

    # ---------------- cut candidates
    sv = json.loads(Path(a.survey).read_text())
    cands = [c for c in sv["candidates"] if c["ratio"] >= 4]
    misses = [c for c in cands if not c["cut"]]
    controls = [c for c in cands if c["cut"]]
    rng.shuffle(controls)
    cut_items = sorted(misses + controls[:N_CUT_CONTROLS], key=lambda c: c["frame"])
    current_cuts = set(doc.get("cuts") or [])

    need = {p["frame"] for p in picked} | set(miss_frames) | {c["frame"] for c in cut_items} | {c["frame"] - 1 for c in cut_items}
    frames: dict[int, np.ndarray] = {}
    cap = cv2.VideoCapture(a.video)
    i = 0
    last = max(need)
    while i <= last:
        ok, fr = cap.read()
        if not ok:
            break
        if i in need:
            frames[i] = fr
        i += 1
    cap.release()

    items = []
    for k, c in enumerate(cut_items, 1):
        iid = f"cut-{k:03d}"
        pair = np.hstack([cv2.resize(frames[c["frame"] - 1], (640, 360)), cv2.resize(frames[c["frame"]], (640, 360))])
        cv2.line(pair, (640, 0), (640, 360), (255, 255, 255), 2)
        cv2.imwrite(str(out / "img" / f"{iid}.jpg"), pair, [cv2.IMWRITE_JPEG_QUALITY, 88])
        items.append({"id": iid, "task": "cut", "frame": c["frame"], "t": round(c["frame"] / fps, 2), "img": f"img/{iid}.jpg",
                      "meta": {**c, "current_rule_cut": c["frame"] in current_cuts}})

    for k, p in enumerate(picked, 1):
        iid = f"box-{k:03d}"
        fr = frames[p["frame"]]
        x, y, w, h = p["box"]
        side = max(160, int(max(w, h) * 3))
        cx, cy = x + w / 2, y + h / 2
        x0, y0 = int(max(0, min(W - side, cx - side / 2))), int(max(0, min(H - side, cy - side / 2)))
        side_x, side_y = min(side, W), min(side, H)
        crop = fr[y0:y0 + side_y, x0:x0 + side_x].copy()
        s = 480 / max(side_x, side_y)
        crop = cv2.resize(crop, (int(side_x * s), int(side_y * s)), interpolation=cv2.INTER_CUBIC)
        cv2.rectangle(crop, (int((x - x0) * s), int((y - y0) * s)), (int((x - x0 + w) * s), int((y - y0 + h) * s)), YELLOW, 2)
        cv2.imwrite(str(out / "img" / f"{iid}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        full = fr.copy()
        cv2.rectangle(full, (x, y), (x + w, y + h), YELLOW, 6)
        cv2.imwrite(str(out / "img" / f"{iid}_full.jpg"), cv2.resize(full, (640, 360)), [cv2.IMWRITE_JPEG_QUALITY, 85])
        items.append({"id": iid, "task": "box", "frame": p["frame"], "t": round(p["frame"] / fps, 2), "img": f"img/{iid}.jpg",
                      "thumb": f"img/{iid}_full.jpg", "meta": {k2: p[k2] for k2 in ("box", "track", "source", "stratum", "flagged", "visible", "score")}})

    for k, f in enumerate(miss_frames, 1):
        iid = f"miss-{k:03d}"
        im = cv2.resize(frames[f], (1280, 720))
        sx, sy = 1280 / W, 720 / H
        masked, ellipses = [], []
        for t in doc["tracks"]:
            b = t["frames"].get(str(f))
            if b is None or t["id"] in vis:
                continue
            ex, ey, ew, eh = face_ellipse_box(b)
            ellipses.append({"id": t["id"], "cx": ex + ew / 2, "cy": ey + eh / 2, "rx": ew / 2, "ry": eh / 2})
            cv2.ellipse(im, (int((ex + ew / 2) * sx), int((ey + eh / 2) * sy)), (max(1, int(ew / 2 * sx)), max(1, int(eh / 2 * sy))),
                        0, 0, 360, MAGENTA, 2)
            masked.append(t["id"])
        cv2.imwrite(str(out / "img" / f"{iid}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 88])
        items.append({"id": iid, "task": "miss", "frame": f, "t": round(f / fps, 2), "img": f"img/{iid}.jpg",
                      "img_w": 1280, "img_h": 720, "ellipses": ellipses, "meta": {"masked_tracks": masked}})

    sheet = {"title": a.title or Path(a.video).stem, "video": a.video, "fps": fps, "width": W, "height": H,
             "frameCount": n, "made_from": {"tracks": a.tracks, "base_tracks": a.base_tracks, "edits": a.edits}, "items": items}
    # browsers reject Infinity/NaN in JSON (a survey ratio is inf when the neighbours did not change at all)
    (out / "items.json").write_text(json.dumps(_finite(sheet), ensure_ascii=False, indent=1, allow_nan=False))
    counts = {t: sum(1 for it in items if it["task"] == t) for t in ("cut", "box", "miss")}
    strata = {}
    for p in picked:
        strata[p["stratum"]] = strata.get(p["stratum"], 0) + 1
    print(json.dumps({"items": counts, "box_strata": strata}, ensure_ascii=False))


if __name__ == "__main__":
    main()
