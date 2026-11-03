from mosaic_worker.review import build_review
from mosaic_worker.tracker import Track


def mk(tid, frames, score=0.9, box=(100, 100, 50, 50), held=()):
    return Track(
        id=tid,
        frames={f: box for f in frames},
        scores={f: score for f in frames if f not in held},
        held=set(held),
    )


def refound_elsewhere(t, dx=60):
    """Move the face after every held run by dx, so it is re-found outside the hold box."""
    runs = 0
    for f in sorted(t.frames):
        if f in t.held:
            if f - 1 not in t.held:
                runs += 1
            x, y, w, h = t.frames[f]
            t.frames[f] = (x + dx * (runs - 1), y, w, h)
        else:
            x, y, w, h = t.frames[f]
            t.frames[f] = (x + dx * runs, y, w, h)
    return t


def test_low_confidence_run():
    t = mk("t1", range(0, 20), score=0.5)
    items = build_review([t], 30)["items"]
    assert [i["type"] for i in items] == ["low_confidence"]
    assert items[0]["trackIds"] == ["t1"]
    assert (items[0]["startFrame"], items[0]["endFrame"]) == (0, 19)


def test_high_confidence_and_short_low_run_not_flagged():
    assert build_review([mk("t1", range(0, 40), score=0.9)], 30)["items"] == []
    assert build_review([mk("t1", range(0, 14), score=0.5)], 30)["items"] == []


def test_gap_from_held_frames():
    t = refound_elsewhere(mk("t1", range(0, 30), held=range(10, 15)))
    items = build_review([t], 30)["items"]
    assert len(items) == 1 and items[0]["type"] == "gap"
    assert (items[0]["startFrame"], items[0]["endFrame"]) == (10, 14)


def test_crossing_iou_between_tracks():
    a = mk("t1", range(0, 20), box=(100, 100, 100, 100))
    b = mk("t2", range(0, 20), box=(170, 100, 100, 100))  # overlap 30x100 / union 17000 -> 0.176
    c = mk("t3", range(0, 20), box=(400, 300, 50, 50))
    items = build_review([a, b, c], 30)["items"]
    assert len(items) == 1
    assert items[0]["type"] == "crossing"
    assert items[0]["trackIds"] == ["t1", "t2"]
    assert (items[0]["startFrame"], items[0]["endFrame"]) == (0, 19)


def test_no_crossing_when_iou_small():
    a = mk("t1", range(0, 20), box=(100, 100, 100, 100))
    b = mk("t2", range(0, 20), box=(190, 100, 100, 100))  # overlap 10x100 / 19000 = 0.05
    assert build_review([a, b], 30)["items"] == []


def test_adjacent_items_within_one_second_merge():
    # two held runs 0.8s (24 frames) apart on the same track -> one gap item
    t = refound_elsewhere(mk("t1", range(0, 100), held=list(range(10, 14)) + list(range(38, 42))))
    items = build_review([t], 30)["items"]
    assert len(items) == 1
    assert (items[0]["startFrame"], items[0]["endFrame"]) == (10, 41)
    # more than 1s apart stays separate
    t = refound_elsewhere(mk("t1", range(0, 100), held=list(range(10, 14)) + list(range(50, 54))))
    assert len(build_review([t], 30)["items"]) == 2


def test_ids_and_box_shape():
    t = refound_elsewhere(mk("t1", range(0, 30), held=range(10, 15)))
    it = build_review([t], 30)["items"][0]
    assert it["id"] == "r1" and len(it["box"]) == 4 and all(isinstance(v, int) for v in it["box"])


# --- trailing gaps (the track ended): only keep the ones that can hide a still-present face ---
SIZE = (640, 360)


def trailing(box=(300, 150, 50, 50)):
    # detected 0..29, then held 30..44 and lost
    return mk("t1", range(0, 45), box=box, held=range(30, 45))


def gaps(items):
    return [i for i in items if i["type"] == "gap"]


def test_trailing_gap_mid_screen_without_cut_is_kept():
    items = build_review([trailing()], 30, frame_size=SIZE, frame_count=300, cuts=set())["items"]
    assert len(gaps(items)) == 1


def test_trailing_gap_at_frame_edge_is_dropped():
    # the face walked out of the frame
    items = build_review([trailing(box=(2, 150, 50, 50))], 30, frame_size=SIZE, frame_count=300, cuts=set())["items"]
    assert gaps(items) == []


def test_trailing_gap_after_scene_cut_is_dropped():
    items = build_review([trailing()], 30, frame_size=SIZE, frame_count=300, cuts={31})["items"]
    assert gaps(items) == []


def test_trailing_gap_far_from_scene_cut_is_kept():
    items = build_review([trailing()], 30, frame_size=SIZE, frame_count=300, cuts={200})["items"]
    assert len(gaps(items)) == 1


def test_trailing_gap_at_video_end_is_dropped():
    items = build_review([trailing()], 30, frame_size=SIZE, frame_count=45, cuts=set())["items"]
    assert gaps(items) == []


def test_bridged_gap_is_kept_even_near_edge_or_cut():
    t = refound_elsewhere(mk("t1", range(0, 30), box=(2, 150, 50, 50), held=range(10, 15)))
    items = build_review([t], 30, frame_size=SIZE, frame_count=300, cuts={11})["items"]
    assert len(gaps(items)) == 1


def test_grown_held_box_is_not_a_crossing():
    # held box grew to 100 wide and now overlaps the neighbour; ungrown size does not
    a = Track("t1", {f: (100, 100, 50, 50) for f in range(0, 10)}, {f: 0.9 for f in range(0, 10)}, set())
    for f in range(10, 14):
        a.frames[f] = (100 - 25, 100 - 25, 100, 100)
        a.held.add(f)
    b = mk("t2", range(0, 14), box=(165, 100, 50, 50))
    items = build_review([a, b], 30, frame_size=(1000, 1000), frame_count=1000)["items"]
    assert [i["type"] for i in items] == ["gap"]


def test_two_real_boxes_still_cross():
    a = mk("t1", range(0, 10), box=(100, 100, 50, 50))
    b = mk("t2", range(0, 10), box=(120, 100, 50, 50))
    assert [i["type"] for i in build_review([a, b], 30)["items"]] == ["crossing"]


def test_held_box_with_ungrown_size_overlapping_still_crosses():
    a = Track("t1", {f: (100, 100, 50, 50) for f in range(0, 10)}, {f: 0.9 for f in range(0, 10)}, set())
    for f in range(10, 14):
        a.frames[f] = (100 - 25, 100 - 25, 100, 100)
        a.held.add(f)
    b = mk("t2", range(10, 14), box=(130, 100, 50, 50))
    types = [i["type"] for i in build_review([a, b], 30, frame_size=(1000, 1000), frame_count=1000)["items"]]
    assert "crossing" in types


# --- gaps that cannot expose a face: the hold box keeps masking until the face is found again inside it ---
def two_phase(hold_box, found_box, found_from=15, hold=range(10, 15), end=30):
    """Detected 0..9, held 10..14 (box grown to hold_box), re-found at found_from with found_box."""
    frames = {f: (100, 100, 50, 50) for f in range(0, 10)}
    frames.update({f: hold_box for f in hold})
    frames.update({f: found_box for f in range(found_from, end)})
    scores = {f: 0.9 for f in frames if f not in hold}
    return Track("t1", frames, scores, set(hold))


HOLD = (90, 90, 80, 80)


def test_mid_gap_refound_inside_hold_box_is_not_reviewed():
    t = two_phase(HOLD, (105, 105, 50, 50))
    assert gaps(build_review([t], 30, frame_size=SIZE, frame_count=300)["items"]) == []


def test_mid_gap_refound_outside_hold_box_is_reviewed():
    t = two_phase(HOLD, (140, 105, 50, 50))  # right edge 190 > 170
    assert len(gaps(build_review([t], 30, frame_size=SIZE, frame_count=300)["items"])) == 1


def other_track(start, box):
    return mk("t2", range(start, start + 20), box=box)


def test_trailing_gap_handed_off_inside_hold_box_is_not_reviewed():
    t = mk("t1", range(0, 15), box=(100, 100, 50, 50), held=range(10, 15))
    t.frames.update({f: HOLD for f in range(10, 15)})
    u = other_track(12, (105, 105, 50, 50))
    items = build_review([t, u], 30, frame_size=SIZE, frame_count=300, cuts=set())["items"]
    assert gaps(items) == []


def test_trailing_gap_handoff_outside_hold_box_is_reviewed():
    t = mk("t1", range(0, 15), box=(100, 100, 50, 50), held=range(10, 15))
    t.frames.update({f: HOLD for f in range(10, 15)})
    u = other_track(12, (300, 105, 50, 50))
    items = build_review([t, u], 30, frame_size=SIZE, frame_count=300, cuts=set())["items"]
    assert len(gaps(items)) == 1


def test_trailing_gap_handoff_after_hold_is_reviewed():
    t = mk("t1", range(0, 15), box=(100, 100, 50, 50), held=range(10, 15))
    t.frames.update({f: HOLD for f in range(10, 15)})
    u = other_track(16, (105, 105, 50, 50))  # b + 2
    items = build_review([t, u], 30, frame_size=SIZE, frame_count=300, cuts=set())["items"]
    assert len(gaps(items)) == 1


def test_low_confidence_and_crossing_unchanged():
    a = mk("t1", range(0, 20), score=0.5, box=(100, 100, 100, 100))
    b = mk("t2", range(0, 20), box=(170, 100, 100, 100))
    types = sorted(i["type"] for i in build_review([a, b], 30, frame_size=SIZE, frame_count=300)["items"])
    assert types == ["crossing", "low_confidence"]


# --- severity (required vs advisory) ---

def _gap_severity(t, **kw):
    items = build_review([t], 30, **kw)["items"]
    gaps = [i for i in items if i["type"] == "gap"]
    assert len(gaps) == 1
    return gaps[0]["severity"]


def test_severity_few_detections_is_advisory():
    # 2 real dets (frames 0 and 4) around a held run
    t = mk("t1", range(0, 5), held=range(1, 4))
    refound_elsewhere(t)
    assert _gap_severity(t) == "advisory"


def test_severity_three_detections_is_required():
    t = mk("t1", range(0, 6), held=range(1, 4))  # real: 0, 4, 5
    refound_elsewhere(t)
    assert _gap_severity(t) == "required"


def test_severity_small_face_is_advisory_boundary():
    # raw side = min(w,h)/1.25 ; 50 -> 40 (required), 49 -> 39.2 (advisory)
    big = refound_elsewhere(mk("t1", range(0, 30), box=(100, 100, 50, 50), held=range(10, 15)))
    small = refound_elsewhere(mk("t1", range(0, 30), box=(100, 100, 49, 49), held=range(10, 15)))
    assert _gap_severity(big) == "required"
    assert _gap_severity(small) == "advisory"


def test_severity_suspect_is_advisory():
    t = refound_elsewhere(mk("t1", range(0, 30), held=range(10, 15)))
    assert _gap_severity(t, suspects={"t1"}) == "advisory"
    assert _gap_severity(t, suspects={"other"}) == "required"


def test_low_confidence_has_severity():
    t = mk("t1", range(0, 20), score=0.5)
    assert build_review([t], 30)["items"][0]["severity"] == "required"
    assert build_review([t], 30, suspects={"t1"})["items"][0]["severity"] == "advisory"


def test_crossing_has_no_severity():
    a = mk("t1", range(0, 20), box=(100, 100, 100, 100))
    b = mk("t2", range(0, 20), box=(120, 100, 100, 100))
    items = build_review([a, b], 30, suspects={"t1", "t2"})["items"]
    crossings = [i for i in items if i["type"] == "crossing"]
    assert crossings and all("severity" not in i for i in crossings)


def test_same_severity_gaps_within_one_second_still_merge():
    # severity is per track, so two gaps of one track share it and merge as before
    t = mk("t1", range(0, 40), held=list(range(10, 14)) + list(range(20, 24)))
    refound_elsewhere(t)
    gaps = [i for i in build_review([t], 30)["items"] if i["type"] == "gap"]
    assert len(gaps) == 1 and gaps[0]["severity"] == "required"


def test_likely_faces_none_keeps_everything():
    t = refound_elsewhere(mk("t1", range(0, 30), held=range(10, 15)))
    assert len(build_review([t], 30, likely_faces=None)["items"]) == 1


def test_likely_faces_demotes_non_likely_to_advisory():
    likely = refound_elsewhere(mk("t1", range(0, 30), held=range(10, 15)))
    other = refound_elsewhere(mk("t2", range(0, 30), held=range(10, 15), box=(300, 200, 50, 50)))
    items = build_review([likely, other], 30, likely_faces={"t1"})["items"]
    assert {tuple(i["trackIds"]): i["severity"] for i in items} == {("t1",): "required", ("t2",): "advisory"}
    # an item that is advisory anyway (too few detections) stays advisory for a likely face
    short = refound_elsewhere(mk("t3", range(0, 4), held=range(1, 3)))
    assert [i["severity"] for i in build_review([short], 30, likely_faces={"t3"})["items"]] == ["advisory"]


def test_likely_faces_crossing_needs_both_tracks():
    a = mk("t1", range(0, 20), box=(100, 100, 100, 100))
    b = mk("t2", range(0, 20), box=(170, 100, 100, 100))
    sev = lambda lf: [i.get("severity", "required") for i in build_review([a, b], 30, likely_faces=lf)["items"]]
    both = sev({"t1", "t2"})
    assert both == ["required"]
    assert sev({"t1"}) == ["advisory"]
    assert sev(set()) == ["advisory"]
