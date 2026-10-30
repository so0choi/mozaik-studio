import urllib.request
from pathlib import Path

import cv2
import pytest

ASSETS = Path(__file__).parent / "assets"
LENA_URL = "https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/lena.jpg"


@pytest.fixture(scope="session")
def face_image():
    ASSETS.mkdir(exist_ok=True)
    path = ASSETS / "face.jpg"
    if not path.exists():
        try:
            with urllib.request.urlopen(LENA_URL, timeout=20) as r:
                path.write_bytes(r.read())
        except Exception as e:  # noqa: BLE001
            pytest.skip(f"could not download face image: {e}")
    img = cv2.imread(str(path))
    if img is None:
        pytest.skip("face image unreadable")
    return img


@pytest.fixture(scope="session")
def model_path():
    from mosaic_worker.detect import default_model_path

    p = default_model_path()
    if not p.exists():
        pytest.skip(f"YuNet model missing: {p}")
    return p
