import numpy as np
import pytest

from mosaic_worker.detect import Detection
from mosaic_worker.person import PersonDetector, PersonGate, default_person_model_path, head_supported

FRAME = np.zeros((360, 640, 3), np.uint8)
PERSON = (100, 100, 100, 200, 0.9)  # x, y, w, h, score -> head zone y in [100, 150) (+5% margin)


def face_at(cx, cy, s=20):
    return (int(cx - s / 2), int(cy - s / 2), s, s)


def D(box, s=0.9):
    return Detection(box, s)


# ---- head_supported ----

def test_face_in_head_zone_is_supported():
    assert head_supported(face_at(150, 120), [PERSON])


def test_face_in_lower_body_is_not_supported():
    assert not head_supported(face_at(150, 220), [PERSON])


def test_face_outside_horizontally_is_not_supported():
    assert not head_supported(face_at(40, 120), [PERSON])


def test_margin_extends_box_by_ten_percent_each_side():
    # expanded person: x in [95, 205], y in [90, 90 + 0.25*220 = 145]
    assert head_supported(face_at(96, 120), [PERSON])
    assert head_supported(face_at(150, 90), [PERSON])  # above the raw box, inside the margin
    assert not head_supported(face_at(94, 120), [PERSON])
    assert not head_supported(face_at(150, 146), [PERSON])
    assert not head_supported(face_at(150, 89), [PERSON])


def test_any_person_box_may_support_and_empty_never_does():
    other = (400, 50, 80, 160, 0.8)
    assert head_supported(face_at(430, 70), [PERSON, other])
    assert not head_supported(face_at(150, 120), [])


# ---- PersonGate ----

class Fake:
    """frame-independent fake detector: returns the boxes registered for the current frame index."""

    def __init__(self, by_frame):
        self.by_frame = by_frame
        self.frame = -1
        self.calls = []

    def __call__(self, frame):
        self.calls.append(self.frame)
        return self.by_frame.get(self.frame, [])


def run(gate, fake, plan, n_frames):
    for i in range(n_frames):
        fake.frame = i
        gate.observe(i, FRAME, plan.get(i, {}))
    gate.finish()


def test_n_is_half_a_second_of_frames():
    f = Fake({})
    g = PersonGate(24, detector=f)
    run(g, f, {}, 30)
    assert f.calls == [0, 12, 24]
    g = PersonGate(1, detector=Fake({}))
    assert g.step == 1


def test_support_no_support_unknown():
    f = Fake({0: [PERSON], 12: [PERSON], 24: []})
    g = PersonGate(24, detector=f)
    plan = {
        0: {"sup": D(face_at(150, 120)), "nos": D(face_at(150, 250))},
        24: {"unk": D(face_at(150, 120))},  # no person in that frame
    }
    run(g, f, plan, 30)
    assert g.state("sup") == "support"
    assert g.state("nos") == "no_support"
    assert g.state("unk") == "unknown"
    assert g.state("never_seen") == "unknown"


def test_any_supported_detection_wins():
    f = Fake({0: [PERSON], 12: [PERSON]})
    g = PersonGate(24, detector=f)
    run(g, f, {0: {"t": D(face_at(150, 250))}, 12: {"t": D(face_at(150, 120))}}, 14)
    assert g.state("t") == "support"


def test_low_score_person_is_ignored():
    f = Fake({0: [(100, 100, 100, 200, 0.2)]})
    g = PersonGate(24, detector=f)
    run(g, f, {0: {"t": D(face_at(150, 120))}}, 2)
    assert g.state("t") == "unknown"


def test_detection_after_person_frame_uses_it_immediately():
    f = Fake({0: [PERSON], 12: []})
    g = PersonGate(24, detector=f)
    # frame 5 is within N/2 = 6 of frame 0
    for i in range(6):
        f.frame = i
        g.observe(i, FRAME, {"t": D(face_at(150, 120))} if i == 5 else {})
    assert g.state("t") == "support"  # judged without waiting for frame 12


def test_detection_nearer_to_next_person_frame_is_judged_by_it():
    # frame 8 is 8 after frame 0 and 4 before frame 12: nearest is 12 (person moved there)
    moved = (300, 100, 100, 200, 0.9)
    f = Fake({0: [PERSON], 12: [moved]})
    g = PersonGate(24, detector=f)
    run(g, f, {8: {"t": D(face_at(350, 120))}}, 14)
    assert g.state("t") == "support"
    # and against frame 0's box it would have failed
    f2 = Fake({0: [PERSON], 12: [moved]})
    g2 = PersonGate(24, detector=f2)
    run(g2, f2, {8: {"t": D(face_at(150, 120))}}, 14)
    assert g2.state("t") == "no_support"


def test_buffered_detections_at_end_are_dropped():
    f = Fake({0: [PERSON]})
    g = PersonGate(24, detector=f)
    run(g, f, {10: {"t": D(face_at(150, 250))}}, 11)  # 10 > 6 after frame 0, no later person frame
    assert g.state("t") == "unknown"


def test_finish_judges_buffer_against_last_frame_when_close():
    f = Fake({0: [PERSON]})
    g = PersonGate(24, detector=f)
    for i in range(5):
        f.frame = i
        g.observe(i, FRAME, {})
    g._buffer.append((4, "t", D(face_at(150, 250))))  # internal: within N/2 of last person frame
    g.finish()
    assert g.state("t") == "no_support"


def test_missing_model_degrades_to_unknown(monkeypatch, tmp_path, caplog):
    monkeypatch.setenv("PERSON_MODEL_PATH", str(tmp_path / "nope.onnx"))
    g = PersonGate(24)
    for i in range(30):
        g.observe(i, FRAME, {"t": D(face_at(150, 120))})
    g.finish()
    assert g.state("t") == "unknown"
    assert sum("person model" in r.message for r in caplog.records) <= 1


def test_detector_error_degrades_to_unknown():
    def boom(frame):
        raise RuntimeError("x")

    g = PersonGate(24, detector=boom)
    g.observe(0, FRAME, {"t": D(face_at(150, 120))})
    g.finish()
    assert g.state("t") == "unknown"


# ---- real decoder ----

def test_real_model_blank_frame_has_no_person():
    p = default_person_model_path()
    if not p.exists():
        pytest.skip(f"person model missing: {p}")
    assert PersonDetector(p).detect(np.zeros((360, 640, 3), np.uint8)) == []
    assert PersonDetector(p).detect(np.full((720, 480, 3), 128, np.uint8)) == []
