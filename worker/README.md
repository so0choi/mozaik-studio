# Face Mosaic Studio worker

Python worker: ffmpeg normalization, YuNet detection, ByteTrack-style tracking, CSRT propagation and
mosaic rendering. Contract: `docs/superpowers/specs/2026-10-30-face-mosaic-studio-design.md` section 3.

## Build

From the repo root:

```sh
docker build -t face-mosaic-worker ./worker
```

The image is `python:3.12-slim` + ffmpeg, installs the package with dev extras and downloads the YuNet model
(`scripts/fetch_model.sh`) at build time.

## Run the tests (canonical path: inside the image)

Tests read the shared fixtures from `contracts/fixtures`, resolved as `<repo>/contracts` relative to the test
files. In the image the code lives in `/app/worker`, so mount the contracts at `/app/contracts`:

```sh
docker run --rm -v "$PWD/contracts:/app/contracts:ro" face-mosaic-worker pytest -q
```

While iterating you can also mount your working tree (needs `worker/models/` from `sh worker/scripts/fetch_model.sh`):

```sh
docker run --rm -v "$PWD/worker:/app/worker" -v "$PWD/contracts:/app/contracts:ro" face-mosaic-worker pytest -q
```

The integration tests need the sample face image (OpenCV `lena.jpg`). It is cached in the image
(`tests/assets/face.jpg`) and otherwise downloaded on demand; the tests skip when it is unavailable.

## Run

```sh
docker run --rm -v jobs-data:/data -e REDIS_URL=redis://host:6379/0 face-mosaic-worker
```

Default command: `python -m mosaic_worker.main`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379/0` | Redis for queues and status hashes |
| `DATA_DIR` | `/data` | Job directories live in `$DATA_DIR/jobs/{jobId}` |
| `FFMPEG_BIN` | imageio-ffmpeg's binary (`/usr/bin/ffmpeg` in the image) | ffmpeg executable |
| `MODEL_PATH` | `worker/models/face_detection_yunet_2023mar.onnx` | YuNet model |
| `LOG_LEVEL` | `INFO` | Python log level |

## Queue behaviour

- Priority: `queue:propagate` > `queue:render` > `queue:analyze`.
- A message is moved atomically to `processing:worker` and removed after it was handled. On startup,
  messages left in `processing:worker` are put back on their original queue.
- Status is written to the Redis hash `job:{id}:status` and mirrored to `/data/jobs/{id}/status.json`
  (same fields: `state`, `progress` as integer, `error` as empty string when none, `updatedAt`).
