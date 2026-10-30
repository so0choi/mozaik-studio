from mosaic_worker.review import build_review
from mosaic_worker.tracker import Track


def mk(tid, frames, score=0.9, box=(100, 100, 50, 50), held=()):
    return Track(
        id=tid,
        frames={f: box for f in frames},
        scores={f: score for f in frames if f not in held},
        held=set(held),
    )


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
    t = mk("t1", range(0, 30), held=range(10, 15))
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
    t = mk("t1", range(0, 100), held=list(range(10, 14)) + list(range(38, 42)))
    items = build_review([t], 30)["items"]
    assert len(items) == 1
    assert (items[0]["startFrame"], items[0]["endFrame"]) == (10, 41)
    # more than 1s apart stays separate
    t = mk("t1", range(0, 100), held=list(range(10, 14)) + list(range(50, 54)))
    assert len(build_review([t], 30)["items"]) == 2


def test_ids_and_box_shape():
    t = mk("t1", range(0, 30), held=range(10, 15))
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
    t = mk("t1", range(0, 30), box=(2, 150, 50, 50), held=range(10, 15))
    items = build_review([t], 30, frame_size=SIZE, frame_count=300, cuts={11})["items"]
    assert len(gaps(items)) == 1
