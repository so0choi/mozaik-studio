from mosaic_worker.link import cover_leading
from mosaic_worker.tracker import Track


def _track(frames, reals, tid="t1"):
    return Track(tid, frames, {f: 0.9 for f in reals}, {f for f in frames if f not in reals})


BOX = (0, 150, 116, 351)


def test_masks_frames_before_first_detection_from_video_start():
    # conversation clip: a side face at the left edge is first detected at frame 3
    t = _track({3: BOX, 4: BOX}, [3, 4])
    out = cover_leading([t], fps=30)[0]
    assert [out.frames[f] for f in (0, 1, 2)] == [BOX, BOX, BOX]
    assert out.held == {0, 1, 2}
    assert out.scores == t.scores


def test_reaches_back_at_most_a_quarter_second():
    # 0.5 s put 14 of 15 labeled leading boxes on non-faces; 0.25 s kept every labeled face covered
    t = _track({100: BOX}, [100])
    out = cover_leading([t], fps=24)[0]
    assert min(out.frames) == 100 - 6


def test_never_reaches_back_across_a_cut():
    # cut at 95 = first frame of the new shot: frames 95.. may be covered, 94 and earlier may not
    t = _track({100: BOX}, [100])
    out = cover_leading([t], fps=24, cuts={95})[0]
    assert min(out.frames) == 95


def test_skip_ids_untouched_and_existing_frames_kept():
    a = _track({10: BOX}, [10], "a")
    b = _track({8: (1, 1, 1, 1), 10: BOX}, [10], "b")  # 8 is an existing held frame
    out = {t.id: t for t in cover_leading([a, b], fps=24, skip={"a"})}
    assert out["a"].frames == a.frames
    assert out["b"].frames[8] == (1, 1, 1, 1)
    assert out["b"].frames[7] == BOX
