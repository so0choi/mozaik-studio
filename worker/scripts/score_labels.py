"""Debug only: score a pipeline run (tracks doc + edits) against human labels from label_server.py.

  python scripts/score_labels.py SHEET_DIR --tracks T.json --edits E.json [--tracks T2.json ...]

Scores (only over answered items, 'unsure' is skipped and counted):
  exposure   labeled faces (box=face regions, miss=clicked points) NOT covered by a rendered mask  -> must not grow
  overmask   labeled non-faces covered by a rendered mask (box answers + clicks inside a wrong mask)  -> lower is better
  cuts       labeled cut / same frames vs the run's cut list (tracks doc "cuts" key, from debug_stages --dump-tracks)
A region counts as covered when >= COVER of its area lies inside the union of the run's mask ellipses (the same
ellipse the renderer uses). No precision/recall over the whole video: only the labeled sample is scored.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mosaic_worker.shapes import face_ellipse_box  # noqa: E402

COVER = 0.5


def mask_at(doc: dict, vis: set, f: int, W: int, H: int) -> np.ndarray:
    m = np.zeros((H, W), np.uint8)
    for t in doc["tracks"]:
        b = t["frames"].get(str(f))
        if b is None or t["id"] in vis:
            continue
        ex, ey, ew, eh = face_ellipse_box(b)
        cv2.ellipse(m, (int(ex + ew / 2), int(ey + eh / 2)), (max(1, int(ew / 2)), max(1, int(eh / 2))), 0, 0, 360, 1, -1)
    return m


def score(sheet: dict, labels: dict, doc: dict, vis: set) -> dict:
    W, H = sheet["width"], sheet["height"]
    cuts = set(doc.get("cuts") or [])
    r = {"answered": 0, "unsure": 0,
         "faces_labeled": 0, "faces_exposed": [], "nonfaces_labeled": 0, "nonfaces_masked": [],
         "wrong_labeled": 0, "wrong_still_masked": [], "kept_labeled": 0, "kept_uncovered": [],
         "cut_labeled": 0, "cut_missed": [], "cut_false": [], "cut_ok": 0}
    cache: dict[int, np.ndarray] = {}

    def m(f):
        if f not in cache:
            cache[f] = mask_at(doc, vis, f, W, H)
        return cache[f]

    for it in sheet["items"]:
        ans = labels.get(it["id"])
        if not ans:
            continue
        r["answered"] += 1
        lab = ans.get("label")
        if lab == "unsure":
            r["unsure"] += 1
            continue
        f = it["frame"]
        if it["task"] == "cut":
            r["cut_labeled"] += 1
            pred = f in cuts
            if lab == "cut" and not pred:
                r["cut_missed"].append(f)
            elif lab == "same" and pred:
                r["cut_false"].append(f)
            else:
                r["cut_ok"] += 1
        elif it["task"] == "box":
            x, y, w, h = it["meta"]["box"]
            cov = float(m(f)[y:y + h, x:x + w].mean()) if w > 0 and h > 0 else 0.0
            if lab == "face":
                r["faces_labeled"] += 1
                if cov < COVER:
                    r["faces_exposed"].append(f"{it['id']}@{f}")
            elif lab == "not_face":
                r["nonfaces_labeled"] += 1
                if cov >= COVER:
                    r["nonfaces_masked"].append(f"{it['id']}@{f}")
        elif it["task"] == "miss":
            if ans.get("v") == 2:  # every drawn mask the labeler did not mark wrong must stay covered
                wrong_ids = {w["id"] for w in ans.get("wrong") or []}
                for e in it.get("ellipses") or []:
                    if e["id"] in wrong_ids:
                        continue
                    r["kept_labeled"] += 1
                    x0, y0 = int(max(0, e["cx"] - e["rx"] * 0.7)), int(max(0, e["cy"] - e["ry"] * 0.7))
                    x1, y1 = int(min(W, e["cx"] + e["rx"] * 0.7)), int(min(H, e["cy"] + e["ry"] * 0.7))
                    if x1 > x0 and y1 > y0 and float(m(f)[y0:y1, x0:x1].mean()) < COVER:
                        r["kept_uncovered"].append(f"{it['id']}@{f}:{e['id']}")
            for px, py in ans.get("wrong_points") or []:  # clicked inside a mask that covers no face
                r["wrong_labeled"] += 1
                px, py = int(min(W - 1, max(0, px))), int(min(H - 1, max(0, py)))
                if m(f)[py, px]:
                    r["wrong_still_masked"].append(f"{it['id']}@{f}({px},{py})")
            for px, py in (ans.get("points") or []) if lab == "faces" else []:
                r["faces_labeled"] += 1
                px, py = int(min(W - 1, max(0, px))), int(min(H - 1, max(0, py)))
                if not m(f)[py, px]:
                    r["faces_exposed"].append(f"{it['id']}@{f}({px},{py})")
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sheet")
    ap.add_argument("--tracks", action="append", required=True)
    ap.add_argument("--edits", required=True)
    a = ap.parse_args()
    sheet = json.loads((Path(a.sheet) / "items.json").read_text())
    lp = Path(a.sheet) / "labels.json"
    labels = json.loads(lp.read_text()) if lp.exists() else {}
    vis = set(json.loads(Path(a.edits).read_text()).get("visible") or [])
    rows = {}
    for t in a.tracks:
        r = score(sheet, labels, json.loads(Path(t).read_text()), vis)
        rows[t] = r
        print(f"== {t}")
        print(f"   answered {r['answered']} / {len(sheet['items'])} (unsure {r['unsure']})")
        print(f"   faces exposed   {len(r['faces_exposed'])} / {r['faces_labeled']}  {r['faces_exposed'][:12]}")
        print(f"   non-faces masked {len(r['nonfaces_masked'])} / {r['nonfaces_labeled']}  {r['nonfaces_masked'][:12]}")
        print(f"   kept masks (unclicked = face) now uncovered {len(r['kept_uncovered'])} / {r['kept_labeled']}  {r['kept_uncovered'][:8]}")
        print(f"   wrong masks (whole-frame clicks) still masked {len(r['wrong_still_masked'])} / {r['wrong_labeled']}")
        print(f"   cuts ok {r['cut_ok']} / {r['cut_labeled']}  missed {r['cut_missed']}  false {r['cut_false']}")
    (Path(a.sheet) / "score.json").write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
