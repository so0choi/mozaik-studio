from mosaic_worker.jobs import oversized_suspect_ids
from mosaic_worker.tracker import Track


def mk(tid, real, w):
    box = (100, 100, w, int(w * 1.2))
    return Track(tid, {f: box for f in real}, {f: 0.7 for f in real}, set())


FACES = [mk("t1", range(0, 20), 100), mk("t2", range(0, 20), 120)]  # reference median width 110


def ids(tracks, flagged, skip=frozenset()):
    return oversized_suspect_ids(tracks, flagged, skip)


def test_short_huge_flagged_box_is_unmasked():
    # pexels-9003393 31 s: YuNet scored a chest 0.67 twice, box ~3.6x the faces on screen
    big = mk("t9", [5, 7], 400)
    assert ids(FACES + [big], {"t9"}) == {"t9"}


def test_unflagged_box_is_never_touched():
    assert ids(FACES + [mk("t9", [5, 7], 400)], set()) == set()


def test_below_ratio_stays_masked():
    # a capped and masked face on like-jennie sat at 2.99x; 3.5x keeps a margin from it
    assert ids(FACES + [mk("t9", [5, 7], 380)], {"t9"}) == set()  # 380 / 110 = 3.45


def test_long_lived_box_stays_masked():
    assert ids(FACES + [mk("t9", [3, 5, 7, 9], 500)], {"t9"}) == set()


def test_no_other_face_on_screen_stays_masked():
    assert ids([mk("t9", [5, 7], 500)], {"t9"}) == set()


def test_unmasked_boxes_are_not_a_size_reference():
    tiny = mk("t3", range(0, 20), 10)  # already nonface: must not shrink the reference
    assert ids([mk("t1", range(0, 20), 150), tiny, mk("t9", [5], 500)], {"t9", "t3"}, skip={"t3"}) == set()


def test_one_hit_flagged_is_nonface():
    from mosaic_worker.jobs import one_hit_suspect_ids
    one = mk("t8", [5], 100)
    two = mk("t9", [5, 6], 100)
    assert one_hit_suspect_ids([one, two, FACES[0]], {"t8", "t9", "t1"}) == {"t8"}
    assert one_hit_suspect_ids([one], set()) == set()
