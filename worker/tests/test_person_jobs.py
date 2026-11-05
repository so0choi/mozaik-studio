import json

from mosaic_worker import jobs
from mosaic_worker.normalize import Meta
from mosaic_worker.tracker import Track


def test_linked_person_states():
    groups = {"t1": ["t1", "t2"], "t3": ["t3"], "t4": ["t4", "t5"], "t6": ["t6"]}
    part = {"t1": "unknown", "t2": "support", "t3": "no_support", "t4": "no_support", "t5": "unknown"}
    out = jobs.linked_person_states(groups, lambda p: part.get(p, "unknown"))
    assert out == {"t1": "support", "t3": "no_support", "t4": "no_support", "t6": "unknown"}


def test_nonface_needs_suspect_and_no_support():
    states = {"a": "no_support", "b": "no_support", "c": "unknown", "d": "support", "e": "unknown"}
    suspects = {"a", "c", "d"}
    assert jobs.nonface_ids(suspects, states) == {"a"}
    assert jobs.likely_face_ids(["a", "b", "c", "d", "e"], suspects, states) == {"e"}  # a, c, d are suspects; b is contradicted by the person gate
    # b: not suspect but no_support -> neither non-face nor likely face (still masked, never in review)
    assert "b" not in jobs.likely_face_ids(["b"], suspects, states)


class FakeThumbs:
    def write(self, ids, job_dir):
        return {}


def test_analyze_flags_nonface_and_unmasks_only_it(tmp_path, monkeypatch):
    meta = Meta(fps=30, width=640, height=360, frame_count=60, duration_sec=2.0, has_audio=False)
    box = (100, 100, 50, 50)
    nonface = Track("t1", {f: box for f in range(30)}, {f: 0.7 for f in range(30)}, set())
    face = Track("t2", {f: (300, 100, 50, 50) for f in range(30)}, {f: 0.9 for f in range(30)}, set())

    def fake(video, m, detector, progress=None, person_detector=None):
        return [nonface, face], FakeThumbs(), {"t1"}, frozenset(), {"t1": "no_support", "t2": "support"}

    monkeypatch.setattr(jobs, "detect_and_track", fake)
    jobs.analyze(tmp_path, detector=object(), meta=meta)
    doc = json.loads((tmp_path / "tracks.json").read_text())
    assert {t["id"]: (t["suspect"], t["nonface"]) for t in doc["tracks"]} == {"t1": (True, True), "t2": (False, False)}
    assert json.loads((tmp_path / "edits.json").read_text())["visible"] == ["t1"]


def test_bucket_adds_no_person_tracks_but_not_unknown_or_supported():
    from mosaic_worker.jobs import bucket_ids, nonface_ids

    states = {"a": "no_support", "b": "support", "c": "unknown", "d": "no_support"}
    assert bucket_ids(["a", "b", "c", "d"], {"d"}, states) == {"a", "d"}
    # only the crop-failed + no-person track is pre-checked
    assert nonface_ids({"d"}, states) == {"d"}


def test_seed_unmasked_adds_ids_and_keeps_other_edits(tmp_path):
    import json
    from mosaic_worker.jobs import seed_unmasked

    (tmp_path / "edits.json").write_text(json.dumps({"version": 1, "visible": ["t5"], "groups": [{"id": "g1"}]}))
    seed_unmasked(tmp_path, {"t12", "t5", "t3"})
    e = json.loads((tmp_path / "edits.json").read_text())
    assert e["visible"] == ["t5", "t3", "t12"]
    assert e["groups"] == [{"id": "g1"}]


def test_seed_unmasked_creates_default_edits_when_missing(tmp_path):
    import json
    from mosaic_worker.jobs import seed_unmasked
    from mosaic_worker.render import default_edits

    seed_unmasked(tmp_path, {"t1"})
    e = json.loads((tmp_path / "edits.json").read_text())
    assert e == {**default_edits(), "visible": ["t1"]}


def test_seed_unmasked_noop_without_ids(tmp_path):
    from mosaic_worker.jobs import seed_unmasked

    seed_unmasked(tmp_path, set())
    assert not (tmp_path / "edits.json").exists()
