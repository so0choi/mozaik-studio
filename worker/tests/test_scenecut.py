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


def stripes(color, vertical, seed):
    """Dark coloured stripes: hue sets the histogram, stripe direction sets the structure."""
    rng = np.random.default_rng(seed)
    base = np.empty((H, W, 3), np.float32)
    base[:] = color
    axis = np.arange(W if vertical else H, dtype=np.float32)
    wave = 20 * np.sign(np.sin(axis * 2 * np.pi / 16))
    base += (wave[None, :, None] if vertical else wave[:, None, None])
    base += rng.normal(0, 2, (H, W, 1)).astype(np.float32)
    return base


DARK_RED_V = stripes((10, 10, 70), True, 4)
DARK_BLUE_H = stripes((70, 20, 10), False, 5)
DARK_BLUE_V = stripes((70, 20, 10), True, 5)


def test_dark_hard_cut_with_small_gray_diff_detected():
    # Stage video, frame 2037: hist 0.64 (7x neighbours) but gray diff 24.5 < 25 -> the held close-up box
    # stayed over the next shot. Structure changes completely, so it is a cut.
    rng = np.random.default_rng(0)
    frames = [noisy(DARK_RED_V, rng) for _ in range(40)] + [noisy(DARK_BLUE_H, rng) for _ in range(40)]
    assert run(frames, fps=24).cuts == {40}


def test_dark_lighting_change_same_structure_not_a_cut():
    # Strobe / stage light colour change: histogram jumps, structure stays.
    rng = np.random.default_rng(0)
    frames = [noisy(DARK_RED_V, rng) for _ in range(40)] + [noisy(DARK_BLUE_V, rng) for _ in range(40)]
    assert run(frames, fps=24).cuts == set()


def test_cut_to_flat_black_not_rescued_by_structure():
    # A flat frame has no structure to compare; only the original gray-diff rule may call it a cut.
    rng = np.random.default_rng(0)
    dim = stripes((5, 5, 40), True, 6)  # gray diff to black stays under 25, so only a rescue could fire
    black = np.full((H, W, 3), 6, np.float32)
    frames = [noisy(dim, rng) for _ in range(40)] + [noisy(black, rng) for _ in range(40)]
    sc = run(frames, fps=24)
    assert 40 not in sc.cuts
