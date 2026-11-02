from mosaic_worker.jobs import linked_suspects
from mosaic_worker.link import link_fragments
from mosaic_worker.tracker import Track

FPS = 30  # link gap = 5 frames


def mk(tid, real, held=(), box=(100, 100, 50, 50), boxes=None):
    frames = {f: box for f in list(real) + list(held)}
    if boxes:
        frames.update(boxes)
    return Track(tid, frames, {f: 0.9 for f in real}, set(held))


def contains(outer, inner):
    return (outer[0] <= inner[0] and outer[1] <= inner[1]
            and outer[0] + outer[2] >= inner[0] + inner[2] and outer[1] + outer[3] >= inner[1] + inner[3])


def test_simple_link():
    a, b = mk("t1", range(0, 10)), mk("t2", range(12, 20))
    out, groups = link_fragments([a, b], FPS)
    assert [t.id for t in out] == ["t1"]
    assert groups == {"t1": ["t1", "t2"]}
    assert 10 not in out[0].frames and 12 in out[0].frames and max(out[0].scores) == 19


def test_frames_contiguous_when_a_held():
    a, b = mk("t1", range(0, 10), held=range(10, 12)), mk("t2", range(12, 20))
    out, _ = link_fragments([a, b], FPS)
    assert sorted(out[0].frames) == list(range(0, 20))
    assert out[0].held == {10, 11}


def test_union_on_overlap_and_property():
    a = mk("t1", range(0, 10), held=range(10, 14), boxes={f: (100 + 3 * (f - 9), 100, 60, 60) for f in range(10, 14)})
    b = mk("t2", range(12, 20), box=(100, 100, 50, 50))
    out, _ = link_fragments([a, b], FPS)
    m = out[0]
    for part in (a, b):
        for f, box in part.frames.items():
            assert contains(m.frames[f], box)
    # frame 12: A held (109..169 x), B real (100..150 x) -> union
    assert m.frames[12] == (100, 100, 69, 60)
    assert 12 in m.scores and 12 not in m.held and 10 in m.held


def test_union_non_overlapping_seam():
    a = mk("t1", range(0, 10), held=[10, 11, 12], boxes={f: (300, 100, 50, 50) for f in (10, 11, 12)})
    b = mk("t2", range(12, 20), box=(100, 100, 50, 50))
    out, groups = link_fragments([a, b], FPS)
    assert groups == {"t1": ["t1", "t2"]}
    for part in (a, b):
        for f, box in part.frames.items():
            assert contains(out[0].frames[f], box)
    assert out[0].frames[12] == (100, 100, 250, 50)


def test_two_bs_for_one_a_no_link():
    a = mk("t1", range(0, 10))
    b, c = mk("t2", range(12, 20)), mk("t3", range(13, 20))
    out, groups = link_fragments([a, b, c], FPS)
    assert [t.id for t in out] == ["t1", "t2", "t3"]
    assert all(len(v) == 1 for v in groups.values())


def test_two_as_for_one_b_no_link():
    a, c = mk("t1", range(0, 10)), mk("t2", range(0, 11))
    b = mk("t3", range(13, 20))
    out, groups = link_fragments([a, c, b], FPS)
    assert [t.id for t in out] == ["t1", "t2", "t3"]


def test_time_window():
    gap = 5  # 1/6 s at 30 fps
    a = mk("t1", range(0, 10))
    out, _ = link_fragments([a, mk("t2", range(9 + gap, 40))], FPS)
    assert [t.id for t in out] == ["t1"]
    out, _ = link_fragments([a, mk("t2", range(9 + gap + 1, 40))], FPS)
    assert [t.id for t in out] == ["t1", "t2"]


def test_overlapping_real_frames_never_link():
    a = mk("t1", [*range(0, 10), 20])
    b = mk("t2", range(12, 18))
    out, _ = link_fragments([a, b], FPS)
    assert [t.id for t in out] == ["t1", "t2"]


def test_distance_gate():
    # A box 62.5 wide (raw side 50); B centre shifted by dx
    a = Track("t1", {f: (100, 100, 62, 62) for f in range(10)}, {f: 0.9 for f in range(10)})
    def b_at(dx):
        return Track("t2", {f: (100 + dx, 100, 62, 62) for f in range(12, 20)}, {f: 0.9 for f in range(12, 20)})
    out, _ = link_fragments([a, b_at(49)], FPS)  # side = 62/1.25 = 49.6
    assert len(out) == 1
    out, _ = link_fragments([a, b_at(51)], FPS)
    assert len(out) == 2


def test_size_ratio_gate():
    a = mk("t1", range(0, 10), box=(100, 100, 50, 50))
    ok = mk("t2", range(12, 20), box=(100, 100, 100, 100))
    bad = mk("t2", range(12, 20), box=(100, 100, 101, 101))
    assert len(link_fragments([a, ok], FPS)[0]) == 1
    assert len(link_fragments([a, bad], FPS)[0]) == 2


def test_extrapolated_centre_path():
    # A real at x=100, then held drifting right; B starts where the held box is
    boxes = {f: (100 + 40 * (f - 9), 100, 50, 50) for f in range(10, 13)}
    a = mk("t1", range(0, 10), held=range(10, 13), boxes=boxes)
    b = mk("t2", range(13, 20), box=(220, 100, 50, 50))  # A held at 13? not present
    # frame 13 absent in A -> only (i): distance 120 > 40 -> no link
    assert len(link_fragments([a, b], FPS)[0]) == 2
    boxes = {f: (100 + 40 * (f - 9), 100, 50, 50) for f in range(10, 14)}
    a = mk("t1", range(0, 10), held=range(10, 14), boxes=boxes)
    b = mk("t2", range(13, 20), box=(220, 100, 50, 50))  # A held box at 13 = x 260... dist 40
    assert len(link_fragments([a, b], FPS)[0]) == 1


def test_scene_cut_blocks():
    a, b = mk("t1", range(0, 10)), mk("t2", range(12, 20))
    assert len(link_fragments([a, b], FPS, {11})[0]) == 2
    assert len(link_fragments([a, b], FPS, {8})[0]) == 2   # > a_last-2 = 7
    assert len(link_fragments([a, b], FPS, {14})[0]) == 2  # <= b_first+2
    assert len(link_fragments([a, b], FPS, {7})[0]) == 1
    assert len(link_fragments([a, b], FPS, {15})[0]) == 1


def test_chain():
    a, b, c = mk("t1", range(0, 10)), mk("t2", range(12, 30)), mk("t3", range(32, 40))
    out, groups = link_fragments([a, b, c], FPS)
    assert [t.id for t in out] == ["t1"]
    assert groups == {"t1": ["t1", "t2", "t3"]}
    assert max(out[0].scores) == 39


def test_track_without_scores_untouched():
    a = mk("t1", range(0, 10))
    h = Track("t2", {f: (100, 100, 50, 50) for f in range(12, 20)}, {}, set(range(12, 20)))
    out, groups = link_fragments([a, h], FPS)
    assert [t.id for t in out] == ["t1", "t2"]
    assert groups == {"t1": ["t1"], "t2": ["t2"]}


def test_output_sorted_numerically():
    ts = [mk(f"t{i}", range(0, 5), box=(100 + 300 * i, 100, 50, 50)) for i in (2, 10, 1)]
    out, _ = link_fragments(ts, FPS)
    assert [t.id for t in out] == ["t1", "t2", "t10"]


def test_linked_suspects():
    groups = {"t1": ["t1", "t2"], "t3": ["t3"]}
    assert linked_suspects(groups, {"t1", "t2"}) == {"t1"}
    assert linked_suspects(groups, {"t2"}) == set()
    assert linked_suspects(groups, {"t3"}) == {"t3"}
