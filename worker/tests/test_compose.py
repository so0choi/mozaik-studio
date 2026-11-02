import copy
import json
from pathlib import Path

from mosaic_worker.compose import mask_regions

FIX = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"


def load(name):
    return json.loads((FIX / name).read_text())


def sample():
    return load("tracks.sample.json"), copy.deepcopy(load("edits.sample.json")), load("manual.sample.json")


def boxes_by_frame(result):
    return {f: [tuple(r["box"]) for r in rs] for f, rs in result.items()}


def test_matches_expected_regions_exactly():
    tracks, edits, manual = sample()
    expected = {int(k): v for k, v in load("expected-regions.json").items() if not k.startswith("_")}
    result = mask_regions(tracks, edits, manual)
    # frame 89 (and every frame > 60) has no region and must be absent
    assert sorted(result) == list(range(61))
    for frame, regions in expected.items():
        assert result[frame] == regions, f"frame {frame}"
    assert 89 not in result


def test_auto_tracks_always_rect():
    tracks, edits, manual = sample()
    edits["effects"]["overrides"]["t2a"] = {"type": "blur", "strength": 5}
    result = mask_regions(tracks, edits, manual)
    auto = [r for rs in result.values() for r in rs if r["id"] in ("t2a", "t3")]
    assert auto and all(r["shape"] == "rect" and r["points"] is None for r in auto)


def test_group_override_beats_track_override():
    tracks, edits, manual = sample()
    edits["groups"] = [{"id": "g1", "trackIds": ["t3"], "label": ""}]
    edits["effects"]["overrides"]["g1"] = {"type": "color", "color": "#00ff00"}
    r = mask_regions(tracks, edits, manual)
    t3 = [x for x in r[47] if x["id"] == "t3"][0]
    assert t3["effect"]["type"] == "color" and t3["effect"]["color"] == "#00ff00"  # t3 override is blur


def test_split_piece_override_beats_group():
    tracks, edits, manual = sample()
    edits["visible"] = []
    edits["groups"] = [{"id": "g1", "trackIds": ["t2"], "label": ""}]
    edits["effects"]["overrides"] = {"g1": {"type": "color"}, "t2a": {"type": "blur", "strength": 2}}
    r = mask_regions(tracks, edits, manual)
    assert [x["effect"]["type"] for x in r[0] if x["id"] == "t2a"] == ["blur"]
    assert [x["effect"]["type"] for x in r[50] if x["id"] == "t2b"] == ["color"]


def test_unknown_override_key_ignored():
    tracks, edits, manual = sample()
    before = mask_regions(tracks, edits, manual)
    edits["effects"]["overrides"]["t9"] = {"type": "blur", "strength": 5}
    assert mask_regions(tracks, edits, manual) == before


def test_polygon_points_absolute():
    tracks, edits, manual = sample()
    m3 = [r for r in mask_regions(tracks, edits, manual)[60] if r["id"] == "m3"][0]  # no propagation doc: anchor fallback
    assert m3["shape"] == "polygon" and m3["points"] == [[100, 100], [160, 100], [130, 140]]


def _poly_edits():
    return {"manual": [{"id": "m3", "shape": "polygon", "points": [[0, 0], [1, 0], [0.5, 1]],
                        "anchors": [{"frame": 60, "box": [100, 100, 60, 40]}], "trim": None, "deleted": False}]}


def test_polygon_exact_at_anchor_with_expanded_doc():
    doc = {"id": "m3", "frames": {"60": [93, 95, 75, 50]}, "segments": [[60, 60]]}
    r = mask_regions({"tracks": []}, _poly_edits(), [doc])
    assert r[60][0]["box"] == [93, 95, 75, 50]
    assert r[60][0]["points"] == [[100, 100], [160, 100], [130, 140]]


def test_polygon_follows_box_translate_and_scale():
    doc = {"id": "m3", "frames": {"60": [93, 95, 75, 50], "61": [103, 95, 150, 50]}, "segments": [[60, 61]]}
    r = mask_regions({"tracks": []}, _poly_edits(), [doc])
    # B center (178,120); D center (130,120); offsets (-30,-20),(30,-20),(0,20) scaled (2,1)
    assert r[61][0]["points"] == [[118, 100], [238, 100], [178, 140]]


def test_group_membership_after_split():
    tracks, edits, manual = sample()
    edits["visible"] = []
    edits["groups"] = [{"id": "g1", "trackIds": ["t2a", "t2b"], "label": ""}]
    edits["effects"]["overrides"] = {"g1": {"type": "color"}}
    r = mask_regions(tracks, edits, manual)
    assert [x["effect"]["type"] for x in r[10] if x["id"] == "t2a"] == ["color"]
    assert [x["effect"]["type"] for x in r[60] if x["id"] == "t2b"] == ["color"]


def test_effect_defaults_filled():
    tracks, edits, manual = sample()
    del edits["effects"]
    r = mask_regions(tracks, edits, manual)
    assert all(x["effect"] == {"type": "mosaic", "strength": 1, "color": "#000000"} for rs in r.values() for x in rs)


def test_mask_set_unchanged_by_effects():
    tracks, edits, manual = sample()
    base = boxes_by_frame(mask_regions(tracks, edits, manual))
    edits["effects"] = {"default": {"type": "blur", "strength": 5}, "background": None,
                        "overrides": {"t3": {"type": "color"}}}
    edits["manual"][0]["shape"] = "rect"
    assert boxes_by_frame(mask_regions(tracks, edits, manual)) == base


def test_split_boundary_frame_belongs_to_b():
    tracks, edits = load("tracks.sample.json"), load("edits.sample.json")
    r = boxes_by_frame(mask_regions(tracks, edits, []))
    t2_box = (300, 120, 80, 80)
    assert t2_box in r[44] and t2_box not in r[45]  # t2a masked < 45, t2b visible >= 45


def mask_boxes5(tracks, edits, manual):
    """(x, y, w, h, block) tuples per frame, for box/block comparisons."""
    return {f: [(*r["box"], r["block"]) for r in rs] for f, rs in mask_regions(tracks, edits, manual).items()}


def test_deleted_manual_is_ignored_and_trim_applied():
    tracks, edits, manual = load("tracks.sample.json"), load("edits.sample.json"), load("manual.sample.json")
    r = mask_boxes5(tracks, edits, manual)
    assert not any((10, 10, 40, 40, 8) in boxes for boxes in r.values())  # m2 deleted
    assert (200, 200, 40, 40, 8) in r[44] and (200, 200, 40, 40, 8) in r[46]
    assert (200, 200, 40, 40, 8) not in r.get(43, []) and (200, 200, 40, 40, 8) not in r.get(47, [])


def test_default_masks_everything_and_groups_unhide():
    tracks = load("tracks.sample.json")
    base = {"version": 1, "visible": [], "groups": [], "splits": [], "manual": [], "reviewed": []}
    r = mask_boxes5(tracks, base, [])
    assert len(r[40]) == 3 and len(r[0]) == 2  # t1, t2 (and t3 from frame 30)
    grouped = dict(base, visible=["g1"], groups=[{"id": "g1", "trackIds": ["t1", "t2"], "label": "x"}])
    r = mask_boxes5(tracks, grouped, [])
    assert r[40] == [(500, 50, 48, 64, 8)] and 0 not in r


def test_manual_without_edit_entry_is_masked():
    tracks = {"tracks": []}
    manual = [{"id": "mx", "frames": {"3": [0, 0, 100, 40]}, "segments": [[3, 3]]}]
    assert mask_boxes5(tracks, {}, manual) == {3: [(0, 0, 100, 40, 8)]}


def test_manual_edit_without_propagation_doc_masks_anchor_frames():
    # propagation failed or not finished: the preview draws the anchor boxes, so the render must too
    tracks = {"version": 1, "fps": 30, "width": 640, "height": 360, "frameCount": 90, "tracks": []}
    edits = {"visible": [], "groups": [], "splits": [], "reviewed": [],
             "manual": [{"id": "m9", "anchors": [{"frame": 12, "box": [50, 60, 40, 40]},
                                                 {"frame": 80, "box": [10, 10, 64, 32]}],
                         "trim": [0, 50], "deleted": False}]}
    out = mask_boxes5(tracks, edits, [])
    assert out == {12: [(50, 60, 40, 40, 8)]}
