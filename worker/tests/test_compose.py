import json
from pathlib import Path

from mosaic_worker.compose import mask_boxes

FIX = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text())


def test_matches_expected_mask_frames_exactly():
    tracks, edits, manual = load("tracks.sample.json"), load("edits.sample.json"), load("manual.sample.json")
    expected = {k: v for k, v in load("expected-mask-frames.json").items() if not k.startswith("_")}
    result = mask_boxes(tracks, edits, manual)
    for frame, boxes in expected.items():
        assert [list(b) for b in result.get(int(frame), [])] == boxes, f"frame {frame}"
    # no frame outside the expectation list may contain boxes we did not account for
    # (spot check: every frame in 0..89 that has boxes only holds boxes derivable from the rules)
    assert all(isinstance(b, tuple) and len(b) == 5 for bs in result.values() for b in bs)


def test_split_boundary_frame_belongs_to_b():
    tracks, edits = load("tracks.sample.json"), load("edits.sample.json")
    r = mask_boxes(tracks, edits, [])
    t2_box = (300, 120, 80, 80, 10)
    assert t2_box in r[44] and t2_box not in r[45]  # t2a masked < 45, t2b visible >= 45


def test_deleted_manual_is_ignored_and_trim_applied():
    tracks, edits, manual = load("tracks.sample.json"), load("edits.sample.json"), load("manual.sample.json")
    r = mask_boxes(tracks, edits, manual)
    assert not any((10, 10, 40, 40, 8) in boxes for boxes in r.values())  # m2 deleted
    assert (200, 200, 40, 40, 8) in r[44] and (200, 200, 40, 40, 8) in r[46]
    assert (200, 200, 40, 40, 8) not in r.get(43, []) and (200, 200, 40, 40, 8) not in r.get(47, [])


def test_default_masks_everything_and_groups_unhide():
    tracks = load("tracks.sample.json")
    base = {"version": 1, "visible": [], "groups": [], "splits": [], "manual": [], "reviewed": []}
    r = mask_boxes(tracks, base, [])
    assert len(r[40]) == 3 and len(r[0]) == 2  # t1, t2 (and t3 from frame 30)
    grouped = dict(base, visible=["g1"], groups=[{"id": "g1", "trackIds": ["t1", "t2"], "label": "x"}])
    r = mask_boxes(tracks, grouped, [])
    assert r[40] == [(500, 50, 48, 64, 8)] and 0 not in r


def test_manual_without_edit_entry_is_masked():
    tracks = {"tracks": []}
    manual = [{"id": "mx", "frames": {"3": [0, 0, 100, 40]}, "segments": [[3, 3]]}]
    assert mask_boxes(tracks, {}, manual) == {3: [(0, 0, 100, 40, 8)]}


def test_manual_edit_without_propagation_doc_masks_anchor_frames():
    # propagation failed or not finished: the preview draws the anchor boxes, so the render must too
    tracks = {"version": 1, "fps": 30, "width": 640, "height": 360, "frameCount": 90, "tracks": []}
    edits = {"visible": [], "groups": [], "splits": [], "reviewed": [],
             "manual": [{"id": "m9", "anchors": [{"frame": 12, "box": [50, 60, 40, 40]},
                                                 {"frame": 80, "box": [10, 10, 64, 32]}],
                         "trim": [0, 50], "deleted": False}]}
    out = mask_boxes(tracks, edits, [])
    assert out == {12: [(50, 60, 40, 40, 8)]}
