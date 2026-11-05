"""Debug only: stage-by-stage view of the analysis pipeline on a frame window. Not used by the worker.

Re-runs the production classes in the same order as jobs.detect_and_track / jobs.analyze from frame 0
(tracker state needs the frames before the window), and records for every frame in [--start, --end]:

  A  YuNet raw detections (model-input and frame coordinates, score)
  B  NanoDet raw detections, every frame, every class (letterbox and frame coordinates, class name)
  C  tracker input after the score split (high/low) + person-gate head check against B of that frame
  D  tracker output per frame (matched / held / new / ended, miss count, last real detection) and the
     post-processing chain finish -> link -> trim_holds_at_cuts -> inner holds -> bridge -> leading,
     with the stage that first produced each held box
  E  final mask regions (compose.mask_regions with the job's edits) and UI display coordinates

Detection score (`det_score`) is only set on frames with a real YuNet detection; held boxes carry
`det_score: null` and `last_real_frame` instead. The tracker has no track score of its own.

Usage (inside the worker image, from /app/worker):
  python scripts/debug_stages.py VIDEO --start 1920 --end 2160 --out OUT \
      [--tracks-json tracks.json] [--edits edits.json] [--keyframes 2036,2037,2041] \
      [--set scenecut.CUT_RATIO=3] [--set detect.SCORE_THRESHOLD=0.75]
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from mosaic_worker import detect as D  # noqa: E402
from mosaic_worker import link as L  # noqa: E402
from mosaic_worker import person as P  # noqa: E402
from mosaic_worker import scenecut as SC  # noqa: E402
from mosaic_worker import tracker as T  # noqa: E402
from mosaic_worker import verify as V  # noqa: E402
from mosaic_worker import jobs as J  # noqa: E402
from mosaic_worker.compose import mask_regions  # noqa: E402

MODULES = {"detect": D, "link": L, "person": P, "scenecut": SC, "tracker": T, "verify": V, "jobs": J}

COCO = ("person bicycle car motorcycle airplane bus train truck boat traffic_light fire_hydrant stop_sign "
        "parking_meter bench bird cat dog horse sheep cow elephant bear zebra giraffe backpack umbrella handbag "
        "tie suitcase frisbee skis snowboard sports_ball kite baseball_bat baseball_glove skateboard surfboard "
        "tennis_racket bottle wine_glass cup fork knife spoon bowl banana apple sandwich orange broccoli carrot "
        "hot_dog pizza donut cake chair couch potted_plant bed dining_table toilet tv laptop mouse remote keyboard "
        "cell_phone microwave oven toaster sink refrigerator book clock vase scissors teddy_bear hair_drier "
        "toothbrush").split()

COLORS = {"A": (0, 255, 255), "B": (255, 128, 0), "C_high": (0, 255, 0), "C_low": (0, 160, 255),
          "real": (0, 255, 0), "held": (0, 0, 255), "region": (255, 0, 255)}


def apply_overrides(pairs: list[str]) -> dict:
    done = {}
    for p in pairs:
        key, val = p.split("=", 1)
        mod, name = key.split(".", 1)
        m = MODULES[mod]
        old = getattr(m, name)
        setattr(m, name, type(old)(val))
        done[key] = {"old": old, "new": getattr(m, name)}
    return done


def r(v, n=1):
    return [round(float(x), n) for x in v]


# ---------------------------------------------------------------- B: NanoDet, all classes
def nanodet_raw(det: P.PersonDetector, frame: np.ndarray, min_score: float):
    """Same preprocessing/decoding as person.PersonDetector.detect, but keeps every class (argmax)."""
    net = det._load()
    h, w = frame.shape[:2]
    rr = P.INPUT_SIZE / max(h, w)
    nh, nw = int(round(h * rr)), int(round(w * rr))
    px, py = (P.INPUT_SIZE - nw) // 2, (P.INPUT_SIZE - nh) // 2
    canvas = np.zeros((P.INPUT_SIZE, P.INPUT_SIZE, 3), np.uint8)
    canvas[py: py + nh, px: px + nw] = cv2.resize(frame, (nw, nh))
    blob = ((canvas.astype(np.float32) - P._MEAN) / P._STD).transpose(2, 0, 1)[None]
    net.setInput(blob)
    outs = net.forward(net.getUnconnectedOutLayersNames())
    bins = np.arange(P.REG_MAX + 1, dtype=np.float32)
    lb, fb, sc, cl = [], [], [], []
    for stride, cls, reg in zip(P.STRIDES, outs[0::2], outs[1::2]):
        cls = cls.reshape(-1, cls.shape[-1])
        reg = reg.reshape(-1, 4 * (P.REG_MAX + 1))
        g = int(round(len(cls) ** 0.5))
        ys, xs = np.mgrid[0:g, 0:g]
        cx = (xs.ravel() * stride + 0.5 * (stride - 1)).astype(np.float32)
        cy = (ys.ravel() * stride + 0.5 * (stride - 1)).astype(np.float32)
        best = cls.argmax(1)
        p = cls[np.arange(len(cls)), best]
        keep = np.where(p > min_score)[0]
        if not len(keep):
            continue
        d = P._softmax(reg[keep].reshape(-1, 4, P.REG_MAX + 1)) @ bins * stride
        x1, y1, x2, y2 = cx[keep] - d[:, 0], cy[keep] - d[:, 1], cx[keep] + d[:, 2], cy[keep] + d[:, 3]
        for a, b, c, e, s, k in zip(x1, y1, x2, y2, p[keep], best[keep]):
            lb.append([float(a), float(b), float(c - a), float(e - b)])
            fb.append([float((a - px) / rr), float((b - py) / rr), float((c - a) / rr), float((e - b) / rr)])
            sc.append(float(s))
            cl.append(int(k))
    if not fb:
        return []
    idx = np.array(cv2.dnn.NMSBoxes(fb, sc, min_score, P.NMS_IOU)).ravel()
    return [{"cls": COCO[cl[i]] if cl[i] < len(COCO) else str(cl[i]), "score": sc[i],
             "box_model": lb[i], "box_frame": fb[i]} for i in idx]


# ---------------------------------------------------------------- scene-cut metrics (same maths as SceneCuts)
class SceneProbe:
    def __init__(self):
        self.prev = self.prev_gray = self.prev_z = None
        self.rows: dict[int, tuple[float, float, float | None]] = {}

    def observe(self, idx, frame):
        small = cv2.resize(frame, (64, 64))
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [16, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
        z = SC._structure(frame) if hasattr(SC, "_structure") else None
        if self.prev is not None:
            d = cv2.compareHist(self.prev, hist, cv2.HISTCMP_BHATTACHARYYA)
            ncc = float((z * self.prev_z).mean()) if z is not None and self.prev_z is not None else None
            self.rows[idx] = (float(d), float(np.abs(gray - self.prev_gray).mean()), ncc)
        self.prev, self.prev_gray, self.prev_z = hist, gray, z

    def explain(self, idx, w, cuts):
        if idx not in self.rows:
            return None
        d, g, ncc = self.rows[idx]
        near = [self.rows[i][0] for i in range(idx - w, idx + w + 1) if i != idx and i in self.rows]
        med = float(np.median(near)) if near else 0.0
        fails = []
        if d < SC.CUT_MIN_DISTANCE:
            fails.append(f"hist {d:.3f} < {SC.CUT_MIN_DISTANCE}")
        rescue = getattr(SC, "CUT_RESCUE_NCC", -1)
        if g < SC.CUT_MIN_GRAY_DIFF and (ncc is None or ncc >= rescue):
            fails.append(f"gray {g:.1f} < {SC.CUT_MIN_GRAY_DIFF} and ncc {ncc if ncc is None else round(ncc, 3)} >= rescue {rescue}")
        if near and d < SC.CUT_RATIO * med:
            fails.append(f"hist {d:.3f} < {SC.CUT_RATIO} x median {med:.3f}")
        return {"frame": idx, "hist": round(d, 4), "gray": round(g, 2), "ncc": None if ncc is None else round(ncc, 3),
                "median_near": round(med, 4),
                "ratio": round(d / med, 2) if med else None, "cut": idx in cuts, "fails": fails}


# ---------------------------------------------------------------- drawing
def draw(img, box, color, text, thick=2):
    x, y, w, h = (int(round(v)) for v in box)
    cv2.rectangle(img, (x, y), (x + w, y + h), color, thick)
    if text:
        cv2.putText(img, text, (x + 2, max(14, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2, cv2.LINE_AA)


def ellipse(img, box, color):
    x, y, w, h = box
    cv2.ellipse(img, (int(x + w / 2), int(y + h / 2)), (int(w / 2), int(h / 2)), 0, 0, 360, color, 3)


def label(img, text):
    cv2.rectangle(img, (0, 0), (img.shape[1], 44), (0, 0, 0), -1)
    cv2.putText(img, text, (10, 32), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2, cv2.LINE_AA)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--start", type=int, required=True)
    ap.add_argument("--end", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--tracks-json", help="production tracks.json to compare the replay against")
    ap.add_argument("--edits", help="edits.json for stage E (visible ids); default: everything masked")
    ap.add_argument("--keyframes", default="", help="comma list of frames to save stage panels for")
    ap.add_argument("--set", action="append", default=[], help="module.NAME=value override, e.g. scenecut.CUT_RATIO=3")
    ap.add_argument("--display", default="1280x720", help="UI element size for stage E display coordinates")
    ap.add_argument("--full", action="store_true", help="decode to the end (default: window end + 2 s)")
    ap.add_argument("--no-video", action="store_true")
    ap.add_argument("--extend-skip", choices=["nonface", "suspect"], default="nonface",
                    help="experiment: which tracks skip inner-hold/bridge/leading (production: nonface)")
    ap.add_argument("--suspect-hold", type=int, default=-1,
                    help="experiment: keep at most N held frames after each real detection of suspect tracks (-1 = production)")
    ap.add_argument("--dump-tracks", help="write the replayed final tracks doc (whole decoded range) here")
    a = ap.parse_args()

    overrides = apply_overrides(a.set)
    out = Path(a.out)
    (out / "panels").mkdir(parents=True, exist_ok=True)
    keyframes = {int(k) for k in a.keyframes.split(",") if k.strip()}

    cap = cv2.VideoCapture(a.video)
    fps_float = cap.get(cv2.CAP_PROP_FPS)
    fps = int(round(fps_float))
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    stop = n_frames if a.full else min(n_frames, a.end + 2 * fps + 1)

    detector = D.FaceDetector()
    pdet = P.PersonDetector()
    tracker = T.Tracker(fps, frame_size=(W, H))
    verifier = V.TrackVerifier()
    gate = P.PersonGate(fps)
    scene = SC.SceneCuts(fps)
    probe = SceneProbe()

    rows: list[dict] = []
    online: dict[int, dict] = {}  # frame -> {track id -> state}
    frames_cache: dict[int, np.ndarray] = {}
    timing = {"yunet_ms": [], "nanodet_ms": [], "frame_ms": []}
    short = min(W, H)
    model_scale = D.MAX_SHORT_SIDE / short if short > D.MAX_SHORT_SIDE else 1.0

    idx = 0
    t_all = time.time()
    while idx < stop:
        ok, frame = cap.read()
        if not ok:
            break
        t0 = time.perf_counter()
        inwin = a.start <= idx <= a.end
        t1 = time.perf_counter()
        dets = detector.detect(frame)
        yms = (time.perf_counter() - t1) * 1000
        before = {tr.id for tr in tracker._active}
        assigned = tracker.update(idx, dets)
        verifier.observe(frame, assigned)
        gate.observe(idx, frame, assigned)
        scene.observe(idx, frame)
        probe.observe(idx, frame)
        if inwin:
            timing["yunet_ms"].append(yms)
            tsec = idx / fps
            for d in dets:  # A
                rows.append({"frame": idx, "t": round(tsec, 3), "stage": "A", "source": "yunet", "cls": "face",
                             "det_score": round(d.score, 4), "track_id": None,
                             "box_model": r([v * model_scale for v in d.box]), "box_frame": list(d.box),
                             "model_input": [round(W * model_scale), round(H * model_scale)]})
            t2 = time.perf_counter()
            nd = nanodet_raw(pdet, frame, P.PERSON_MIN_SCORE)
            timing["nanodet_ms"].append((time.perf_counter() - t2) * 1000)
            persons = [(*b["box_frame"], b["score"]) for b in nd if b["cls"] == "person"]
            for b in nd:  # B
                rows.append({"frame": idx, "t": round(tsec, 3), "stage": "B", "source": "nanodet", "cls": b["cls"],
                             "det_score": round(b["score"], 4), "track_id": None, "box_model": r(b["box_model"]),
                             "box_frame": r(b["box_frame"]), "model_input": [P.INPUT_SIZE, P.INPUT_SIZE],
                             "gate_sampled_frame": idx % gate.step == 0})
            for d in dets:  # C
                tid = next((k for k, v in assigned.items() if v is d), None)
                rows.append({"frame": idx, "t": round(tsec, 3), "stage": "C", "source": "yunet",
                             "det_score": round(d.score, 4), "box_frame": list(d.box), "track_id": tid,
                             "split": "high" if d.score >= T.HIGH_SCORE else "low",
                             "head_in_person_box_this_frame": P.head_supported(d.box, persons) if persons else None,
                             "reason": ("matched/started" if tid else
                                        "low score, no track to extend -> dropped" if d.score < T.HIGH_SCORE else
                                        "unassigned")})
            states = {}
            after = {tr.id: tr for tr in tracker._active}
            for tid in before - set(after):
                states[tid] = {"event": "ended", "reason": f"miss > hold_frames ({tracker.hold_frames})"}
            for tid, tr in after.items():
                box = tr.frames.get(idx)
                if tid in assigned and tid not in before:
                    ev, why = "new", f"unmatched high-score detection (>= {T.HIGH_SCORE})"
                elif tid in assigned:
                    ev, why = "matched", "IoU/centre match"
                else:
                    ev = "held"
                    why = (f"no detection matched; hold {tr.miss}/{tracker.hold_frames}, "
                           f"size x{T.HOLD_GROWTH}^{tr.miss}={T.HOLD_GROWTH ** tr.miss:.2f}, v=({tr.vx:.1f},{tr.vy:.1f})px/f")
                states[tid] = {"event": ev, "reason": why, "box_raw": r(box) if box else None,
                               "det_score": round(tr.scores[idx], 4) if idx in tr.scores else None,
                               "miss": tr.miss, "last_real_frame": tr.last_real_frame}
            online[idx] = states
            frames_cache[idx] = frame if (idx in keyframes or not a.no_video) else None
        timing["frame_ms"].append((time.perf_counter() - t0) * 1000)
        idx += 1
    cap.release()
    decode_s = time.time() - t_all

    # ---------------- post-processing chain, same order as jobs.detect_and_track / analyze
    scene.finish()
    gate.finish()
    cuts = scene.cuts
    s_finish = tracker.finish()
    s_link, groups = L.link_fragments(s_finish, fps, cuts)
    s_trim = L.trim_holds_at_cuts(s_link, cuts)
    part_suspects = {p for parts in groups.values() for p in parts if not verifier.keep(p)}
    suspects = J.linked_suspects(groups, part_suspects)
    states = J.linked_person_states(groups, gate.state)
    nonface = J.nonface_ids(suspects, states)
    if a.suspect_hold >= 0:  # experiment: suspect tracks do not keep long holds
        cut_tr = []
        for t in s_trim:
            if t.id not in suspects:
                cut_tr.append(t)
                continue
            reals = sorted(t.scores)
            keep = {f: b for f, b in t.frames.items()
                    if f in t.scores or any(0 < f - r <= a.suspect_hold for r in reals)}
            cut_tr.append(T.Track(t.id, keep, dict(t.scores), {f for f in keep if f not in t.scores}))
        s_trim = cut_tr
    ext_skip = nonface if a.extend_skip == "nonface" else set(suspects) | set(nonface)
    s_inner = L.cover_inner_holds(s_trim, cuts, skip=ext_skip)
    s_bridge = L.bridge_gaps(s_inner, fps, cuts, skip=ext_skip)
    s_lead = L.cover_leading(s_bridge, fps, cuts, skip=ext_skip)
    bucket = J.bucket_ids([t.id for t in s_lead], suspects, states)

    class _M:  # build_tracks_doc only needs these
        pass
    m = _M()
    m.fps, m.width, m.height, m.frame_count = fps, W, H, n_frames
    doc = J.build_tracks_doc(m, s_lead, {}, bucket, nonface)
    part_of = {p: k for k, parts in groups.items() for p in parts}
    stages = [("tracker.finish", {part_of.get(t.id, t.id): t for t in s_finish}),
              ("link", {t.id: t for t in s_link}), ("trim_cuts", {t.id: t for t in s_trim}),
              ("inner_hold", {t.id: t for t in s_inner}), ("bridge", {t.id: t for t in s_bridge}),
              ("leading", {t.id: t for t in s_lead})]
    # tracker.finish keyed by linked id: several parts map to one id; rebuild union of their frames
    fin: dict[str, dict] = {}
    for t in s_finish:
        fin.setdefault(part_of.get(t.id, t.id), {}).update(t.frames)
    final = {t.id: t for t in s_lead}

    for tid, t in final.items():
        for f in range(a.start, a.end + 1):
            if f not in t.frames:
                if any(f in s[1][tid].frames for s in stages[1:3] if tid in s[1]) and tid in stages[2][1] and f not in stages[2][1][tid].frames:
                    rows.append({"frame": f, "t": round(f / fps, 3), "stage": "D", "track_id": tid,
                                 "source": "removed", "reason": "held box dropped by trim_holds_at_cuts (cut)"})
                continue
            if f in t.scores:
                src, why = "yunet(real)", "real detection on this frame"
            else:
                src = "tracker.hold" if f in fin.get(tid, {}) else None
                for name, st in stages[1:]:
                    if src is None and tid in st and f in st[tid].frames:
                        src = name
                widened = [n for (n, st), (_, prev) in zip(stages[1:], stages[:-1])
                           if tid in st and tid in prev and f in st[tid].frames and f in prev[tid].frames
                           and tuple(st[tid].frames[f]) != tuple(prev[tid].frames[f])]
                why = f"no detection; box from {src}" + (f", changed by {widened}" if widened else "")
            reals = [s for s in t.scores if s <= f]
            last_real = max(reals) if reals else None
            rows.append({"frame": f, "t": round(f / fps, 3), "stage": "D", "source": src, "track_id": tid,
                         "det_score": round(t.scores[f], 4) if f in t.scores else None,
                         "box_final": list(t.frames[f]), "last_real_frame": last_real,
                         "frames_since_real": (f - last_real) if last_real is not None else None,
                         "suspect": tid in bucket, "nonface": tid in nonface, "reason": why})
    for f, st in online.items():
        for tid, s in st.items():
            rows.append({"frame": f, "t": round(f / fps, 3), "stage": "D_online", "track_id": tid,
                         "linked_id": part_of.get(tid, tid), **s})

    # ---------------- E: mask regions + UI display coordinates
    edits = json.loads(Path(a.edits).read_text()) if a.edits else {"visible": [], "manual": []}
    regions = mask_regions(doc, edits, [])
    dw, dh = (int(v) for v in a.display.split("x"))
    sc = min(dw / W, dh / H)
    ox, oy = (dw - W * sc) / 2, (dh - H * sc) / 2
    for f in range(a.start, a.end + 1):
        for reg in regions.get(f, []):
            b = reg["box"]
            rows.append({"frame": f, "t": round(f / fps, 3), "stage": "E", "track_id": reg["id"], "source": "render",
                         "region_box_frame": b, "shape": reg["shape"],
                         "ui_box_display": r([ox + b[0] * sc, oy + b[1] * sc, b[2] * sc, b[3] * sc])})

    if a.dump_tracks:
        Path(a.dump_tracks).write_text(json.dumps({**doc, "cuts": sorted(cuts)}))
    with open(out / "boxes.jsonl", "w") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    # ---------------- comparison with production tracks.json
    compare = None
    if a.tracks_json:
        prod = json.loads(Path(a.tracks_json).read_text())
        pmap = {(t["id"], int(f)): b for t in prod["tracks"] for f, b in t["frames"].items() if a.start <= int(f) <= a.end}
        rmap = {(t["id"], int(f)): b for t in doc["tracks"] for f, b in t["frames"].items() if a.start <= int(f) <= a.end}
        same = sum(1 for k in pmap if rmap.get(k) == pmap[k])
        compare = {"prod_boxes": len(pmap), "replay_boxes": len(rmap), "identical": same,
                   "only_prod": sorted(f"{k[0]}@{k[1]}" for k in set(pmap) - set(rmap))[:40],
                   "only_replay": sorted(f"{k[0]}@{k[1]}" for k in set(rmap) - set(pmap))[:40]}

    w = max(1, round(fps / 2))
    scene_rows = [probe.explain(f, w, cuts) for f in range(a.start, a.end + 1)]
    scene_rows = [s for s in scene_rows if s]
    top = sorted(scene_rows, key=lambda s: -s["hist"])[:10]
    pick = lambda xs: round(float(np.median(xs)), 1) if xs else None  # noqa: E731
    summary = {
        "video": a.video, "fps_container": fps_float, "fps_used": fps, "size": [W, H], "frame_count": n_frames,
        "window": [a.start, a.end], "window_time_s": [round(a.start / fps, 3), round(a.end / fps, 3)],
        "decoded_frames": idx, "decode_s": round(decode_s, 1),
        "models": {"yunet": D.MODEL_FILE, "nanodet": P.PERSON_MODEL_FILE},
        "config": {"yunet_threshold": D.SCORE_THRESHOLD, "yunet_nms": D.NMS_THRESHOLD, "yunet_max_short_side": D.MAX_SHORT_SIDE,
                   "yunet_input": [round(W * model_scale), round(H * model_scale)],
                   "nanodet_input": P.INPUT_SIZE, "nanodet_min_score": P.PERSON_MIN_SCORE, "gate_step": gate.step,
                   "tracker_high": T.HIGH_SCORE, "iou": T.IOU_THRESHOLD, "hold_frames": tracker.hold_frames,
                   "hold_growth": T.HOLD_GROWTH, "expand": T.EXPAND_RATIO,
                   "scene": {"min_dist": SC.CUT_MIN_DISTANCE, "ratio": SC.CUT_RATIO, "min_gray": SC.CUT_MIN_GRAY_DIFF, "w": w}},
        "overrides": overrides,
        "timing_ms_median": {k: pick(v) for k, v in timing.items()},
        "cuts_all": sorted(cuts), "cuts_in_window": sorted(c for c in cuts if a.start <= c <= a.end),
        "scene_top_hist_in_window": top,
        "compare_with_prod": compare,
        "final_boxes_per_frame": {f: [[t["id"], t["frames"][str(f)], t["scores"].get(str(f))] for t in doc["tracks"] if str(f) in t["frames"]]
                                  for f in sorted(keyframes)},
    }
    (out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    (out / "scene.json").write_text(json.dumps(scene_rows, indent=1))

    # ---------------- overlays
    by_frame: dict[int, list] = {}
    for row in rows:
        by_frame.setdefault(row["frame"], []).append(row)

    def panels(f, frame):
        imgs = {k: frame.copy() for k in "ABCDE"}
        fr = by_frame.get(f, [])
        for row in fr:
            s = row["stage"]
            if s == "A":
                draw(imgs["A"], row["box_frame"], COLORS["A"], f"{row['det_score']:.2f}")
            elif s == "B":
                draw(imgs["B"], row["box_frame"], COLORS["B"], f"{row['cls']} {row['det_score']:.2f}")
            elif s == "C":
                c = COLORS["C_high"] if row["split"] == "high" else COLORS["C_low"]
                draw(imgs["C"], row["box_frame"], c, f"{row['split']} {row['det_score']:.2f} {row['track_id'] or 'drop'}")
            elif s == "D" and row.get("box_final"):
                real = row["det_score"] is not None
                since = row["frames_since_real"]
                txt = (f"{row['track_id']} {row['det_score']:.2f}" if real else
                       f"{row['track_id']} {row['source']} " + (f"+{since}f" if since is not None else "before 1st det"))
                draw(imgs["D"], row["box_final"], COLORS["real" if real else "held"], txt, 3)
            elif s == "E":
                ellipse(imgs["E"], row["region_box_frame"], COLORS["region"])
                draw(imgs["E"], row["region_box_frame"], COLORS["region"], row["track_id"], 1)
        tag = f"f{f} t={f / fps:.2f}s"
        cut = " CUT" if f in cuts else ""
        label(imgs["A"], f"A YuNet raw  {tag}{cut}")
        label(imgs["B"], "B NanoDet raw (all classes)")
        label(imgs["C"], "C tracker input (high/low split)")
        label(imgs["D"], "D after tracking+hold+link (red=no detection)")
        label(imgs["E"], "E render regions (masked only)")
        return imgs

    writer = None
    for f in sorted(frames_cache):
        frame = frames_cache[f]
        if frame is None:
            continue
        imgs = panels(f, frame)
        if f in keyframes:
            for k, im in imgs.items():
                cv2.imwrite(str(out / "panels" / f"f{f}_{k}.jpg"), im, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not a.no_video:
            small = [cv2.resize(imgs[k], (640, 360)) for k in "ADE"]
            row_img = np.hstack(small)
            if writer is None:
                writer = cv2.VideoWriter(str(out / "stages_ADE.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), fps,
                                         (row_img.shape[1], row_img.shape[0]))
            writer.write(row_img)
    if writer is not None:
        writer.release()
    print(json.dumps({k: summary[k] for k in ("window", "window_time_s", "cuts_in_window", "compare_with_prod",
                                               "timing_ms_median", "decode_s")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
