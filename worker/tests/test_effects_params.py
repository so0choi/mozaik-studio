import json
from pathlib import Path

import pytest

from mosaic_worker import effects

FIX = Path(__file__).resolve().parents[2] / "contracts" / "fixtures"
CASES = json.loads((FIX / "effect-params.json").read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: f'{c["fn"]}{tuple(c["args"])}')
def test_matches_shared_effect_params(case):
    got = getattr(effects, case["fn"])(*case["args"])
    if isinstance(case["expected"], float):
        assert abs(got - case["expected"]) < 1e-9
    else:
        assert got == case["expected"] and isinstance(got, int)


def test_strength_factor():
    assert [effects.strength_factor(s) for s in range(1, 6)] == [1, 1.5, 2, 2.5, 3]


def test_normalize_effects_fills_defaults():
    assert effects.normalize_effects({}) == {
        "default": {"type": "blur", "strength": 1, "color": "#000000"}, "background": None, "overrides": {}}
    n = effects.normalize_effects({"effects": {"default": {"type": "blur"}, "background": {"strength": 4},
                                                "overrides": {"t1": {"color": "#ff0000"}}}})
    assert n["default"] == {"type": "blur", "strength": 1, "color": "#000000"}
    assert n["background"] == {"type": "blur", "strength": 4, "color": "#000000"}
    assert n["overrides"]["t1"] == {"type": "blur", "strength": 1, "color": "#ff0000"}
