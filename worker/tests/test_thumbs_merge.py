import numpy as np

from mosaic_worker.thumbs import MAX_SAMPLES, ThumbCollector


def collector():
    c = ThumbCollector(30)
    img = np.zeros((4, 4, 3), dtype=np.uint8)
    c._best["a"] = (1.0, img, (0, 0, 2, 2))
    c._best["b"] = (5.0, img + 1, (0, 0, 2, 2))
    c._samples["a"] = [f"a{i}".encode() for i in range(10)]
    c._samples["b"] = [b"b0"]
    return c


def test_merge_samples_keep_every_part_and_cap():
    c = collector()
    c.merge({"a": ["a", "b"]})
    assert len(c._samples["a"]) == MAX_SAMPLES
    assert b"b0" in c._samples["a"]
    assert c._samples["a"][0] == b"a0"
    assert "b" not in c._samples and "b" not in c._best
    # time order preserved: b0 (last part) is last
    assert c._samples["a"][-1] == b"b0"
    a_part = [s for s in c._samples["a"] if s.startswith(b"a")]
    assert a_part == sorted(a_part, key=lambda s: int(s[1:]))


def test_merge_best_is_highest_rank():
    c = collector()
    c.merge({"a": ["a", "b"]})
    assert c._best["a"][0] == 5.0


def test_merge_single_part_noop():
    c = collector()
    c.merge({"a": ["a"], "b": ["b"]})
    assert len(c._samples["a"]) == 10 and c._best["b"][0] == 5.0
