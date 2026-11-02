import numpy as np

from mosaic_worker.scenecut import SceneCuts

H, W = 90, 160


def scene(color, seed):
    """A flat colour with a fixed texture, so histograms are stable but not degenerate."""
    rng = np.random.default_rng(seed)
    base = np.empty((H, W, 3), np.float32)
    base[:] = color
    base += rng.normal(0, 8, (H, W, 1)).astype(np.float32)
    return base


A = scene((90, 40, 30), 1)
B = scene((60, 200, 230), 2)


def noisy(base, rng):
    return np.clip(base + rng.normal(0, 2, base.shape), 0, 255).astype(np.uint8)


def run(frames, fps=30, finish=True):
    sc = SceneCuts(fps)
    for i, f in enumerate(frames):
        sc.observe(i, f)
    if finish:
        sc.finish()
    return sc


def test_hard_cut_detected():
    rng = np.random.default_rng(0)
    frames = [noisy(A, rng) for _ in range(60)] + [noisy(B, rng) for _ in range(60)]
    assert run(frames).cuts == {60}


def test_slow_pan_not_a_cut():
    x = np.linspace(0, 255, W + 200, dtype=np.float32)
    wide = np.tile(x, (H, 1))
    wide = np.stack([wide, 255 - wide, wide * 0.5 + 40], axis=2)
    frames = [np.clip(wide[:, 2 * i : 2 * i + W], 0, 255).astype(np.uint8) for i in range(90)]
    assert run(frames).cuts == set()


def test_brightness_flicker_not_a_cut():
    rng = np.random.default_rng(0)
    frames = [np.clip(noisy(A, rng).astype(np.int16) + (10 if i % 2 else -10), 0, 255).astype(np.uint8) for i in range(90)]
    assert run(frames).cuts == set()


def test_small_region_change_not_a_cut():
    rng = np.random.default_rng(0)
    frames = []
    for i in range(100):
        f = noisy(A, rng)
        if i >= 50:
            f[int(H * 0.9):, :] = (255, 255, 255)  # subtitle bar
        frames.append(f)
    assert run(frames).cuts == set()


def test_cut_near_end_found_after_finish():
    rng = np.random.default_rng(0)
    frames = [noisy(A, rng) for _ in range(97)] + [noisy(B, rng) for _ in range(3)]
    sc = run(frames, finish=False)
    assert 97 not in sc.cuts
    sc.finish()
    assert sc.cuts == {97}


def test_two_cuts_close_together():
    rng = np.random.default_rng(0)
    C = scene((200, 60, 150), 3)
    frames = [noisy(A, rng) for _ in range(40)] + [noisy(B, rng) for _ in range(15)] + [noisy(C, rng) for _ in range(40)]
    assert run(frames).cuts == {40, 55}
