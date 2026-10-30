import json

import fakeredis
import pytest

from helpers import background, make_video
from mosaic_worker import main as wm
from mosaic_worker.status import UserFacingError


@pytest.fixture
def env(tmp_path):
    r = fakeredis.FakeRedis(decode_responses=True)
    w = wm.Worker(r, tmp_path)
    states = []
    orig = w.status.set

    def spy(job_id, state, progress=None, error=None):
        states.append((state, error))
        orig(job_id, state, progress, error)

    w.status.set = spy
    return r, w, tmp_path, states


def mkjob(base, job_id="job1"):
    d = base / "jobs" / job_id
    d.mkdir(parents=True)
    return d


def push(r, queue, **msg):
    r.lpush(queue, json.dumps(msg))


def test_analyze_states_hash_and_status_json(env, monkeypatch):
    r, w, base, states = env
    d = mkjob(base)

    def fake(job_dir, progress, detector=None, detector_factory=None):
        progress("normalizing", 0)
        progress("analyzing", 0)
        progress("analyzing", 50)

    monkeypatch.setattr(wm.jobs_mod, "run_analyze", fake)
    push(r, wm.Q_ANALYZE, jobId="job1")
    assert w.run_once() is True
    seen = [s for s, _ in states]
    assert seen[0] == "normalizing" and "analyzing" in seen and seen[-1] == "ready"
    h = r.hgetall("job:job1:status")
    assert h["state"] == "ready" and h["progress"] == "100" and h["error"] == "" and h["updatedAt"].endswith("Z")
    assert json.loads((d / "status.json").read_text()) == {**h, "progress": 100}  # E2 mirror
    assert r.llen(wm.PROCESSING) == 0 and r.llen(wm.Q_ANALYZE) == 0


def test_analyze_real_empty_video_ends_ready(env):
    r, w, base, states = env
    d = mkjob(base)
    make_video(d / "original.mp4", [background() for _ in range(15)], fps=30)
    push(r, wm.Q_ANALYZE, jobId="job1")
    w.run_once()
    assert [s for s, _ in states][0] == "normalizing"
    assert r.hget("job:job1:status", "state") == "ready"
    assert json.loads((d / "tracks.json").read_text())["tracks"] == []


def test_user_facing_error_marks_failed(env, monkeypatch):
    r, w, base, states = env
    mkjob(base)

    def boom(*a, **k):
        raise UserFacingError("30분 이하, 4K 이하 영상만 지원합니다.")

    monkeypatch.setattr(wm.jobs_mod, "run_analyze", boom)
    push(r, wm.Q_ANALYZE, jobId="job1")
    w.run_once()
    assert r.hget("job:job1:status", "state") == "failed"
    assert r.hget("job:job1:status", "error") == "30분 이하, 4K 이하 영상만 지원합니다."


def test_unexpected_analyze_error_gets_generic_message(env, monkeypatch):
    r, w, base, states = env
    mkjob(base)
    monkeypatch.setattr(wm.jobs_mod, "run_analyze", lambda *a, **k: 1 / 0)
    push(r, wm.Q_ANALYZE, jobId="job1")
    w.run_once()
    assert r.hget("job:job1:status", "state") == "failed"
    assert r.hget("job:job1:status", "error") == "영상을 분석하지 못했습니다. 다른 파일로 다시 시도해 주세요."


def test_render_success_and_failure(env, monkeypatch):
    r, w, base, states = env
    mkjob(base)
    monkeypatch.setattr(wm.render_mod, "render", lambda d, p: p("rendering", 40))
    push(r, wm.Q_RENDER, jobId="job1")
    w.run_once()
    assert r.hget("job:job1:status", "state") == "rendered"

    monkeypatch.setattr(wm.render_mod, "render", lambda d, p: (_ for _ in ()).throw(RuntimeError("x")))
    push(r, wm.Q_RENDER, jobId="job1")
    w.run_once()
    h = r.hgetall("job:job1:status")
    assert h["state"] == "ready" and h["error"]  # back to ready with an error, retry possible


def test_propagate_status(env, monkeypatch):
    r, w, base, states = env
    mkjob(base)
    calls = []
    monkeypatch.setattr(wm.propagate_mod, "propagate", lambda d, m, a, o: calls.append((m, a, o)))
    push(r, wm.Q_PROPAGATE, jobId="job1", manualId="m1", anchor={"frame": 5, "box": [1, 2, 3, 4]}, otherAnchors=[9])
    w.run_once()
    assert calls == [("m1", {"frame": 5, "box": [1, 2, 3, 4]}, [9])]
    assert r.hget("job:job1:manual:m1", "state") == "done"

    monkeypatch.setattr(wm.propagate_mod, "propagate", lambda *a: 1 / 0)
    push(r, wm.Q_PROPAGATE, jobId="job1", manualId="m2", anchor={"frame": 5, "box": [1, 2, 3, 4]}, otherAnchors=[])
    w.run_once()
    assert r.hget("job:job1:manual:m2", "state") == "failed"


def test_unknown_job_and_garbage_do_not_stop_the_loop(env, monkeypatch):
    r, w, base, states = env
    mkjob(base)
    monkeypatch.setattr(wm.jobs_mod, "run_analyze", lambda *a, **k: None)
    r.lpush(wm.Q_ANALYZE, "not json")
    push(r, wm.Q_ANALYZE, jobId="../etc")
    push(r, wm.Q_ANALYZE, jobId="ghost")
    push(r, wm.Q_ANALYZE, jobId="job1")
    while w.run_once():
        pass
    assert r.hget("job:job1:status", "state") == "ready"
    assert r.exists("job:ghost:status") == 0
    assert r.llen(wm.PROCESSING) == 0


def test_queue_priority_propagate_render_analyze(env, monkeypatch):
    r, w, base, states = env
    mkjob(base)
    order = []
    monkeypatch.setattr(wm.jobs_mod, "run_analyze", lambda *a, **k: order.append("analyze"))
    monkeypatch.setattr(wm.render_mod, "render", lambda d, p: order.append("render"))
    monkeypatch.setattr(wm.propagate_mod, "propagate", lambda *a: order.append("propagate"))
    push(r, wm.Q_ANALYZE, jobId="job1")
    push(r, wm.Q_RENDER, jobId="job1")
    push(r, wm.Q_PROPAGATE, jobId="job1", manualId="m1", anchor={"frame": 0, "box": [0, 0, 5, 5]}, otherAnchors=[])
    while w.run_once():
        pass
    assert order == ["propagate", "render", "analyze"]


def test_fifo_within_a_queue(env, monkeypatch):
    r, w, base, states = env
    mkjob(base, "a")
    mkjob(base, "b")
    seen = []
    monkeypatch.setattr(wm.jobs_mod, "run_analyze", lambda d, *a, **k: seen.append(d.name))
    push(r, wm.Q_ANALYZE, jobId="a")  # LPUSH producer, consumer takes the oldest
    push(r, wm.Q_ANALYZE, jobId="b")
    while w.run_once():
        pass
    assert seen == ["a", "b"]


def test_startup_requeues_unfinished_messages_to_original_queue(env, monkeypatch):
    r, w, base, states = env
    mkjob(base)
    push(r, wm.Q_RENDER, jobId="job1")
    q, raw = w.pop_next()  # worker "crashes" now: message stays in processing:worker
    assert q == wm.Q_RENDER and r.llen(wm.PROCESSING) == 1 and r.llen(wm.Q_RENDER) == 0
    w2 = wm.Worker(r, base)  # new process, no memory of the old one
    assert w2.requeue_processing() == 1
    assert r.lrange(wm.Q_RENDER, 0, -1) == [raw] and r.llen(wm.PROCESSING) == 0
    # and without the src hash (crash between LMOVE and HSET) the queue is inferred
    q, raw = w2.pop_next()
    r.delete(wm.PROCESSING_SRC)
    r.hset("job:job1:status", "state", "rendering")
    assert w2.requeue_processing() == 1
    assert r.lrange(wm.Q_RENDER, 0, -1) == [raw]
