FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

ENV FFMPEG_BIN=/usr/bin/ffmpeg \
    DATA_DIR=/data \
    PYTHONUNBUFFERED=1

# Layout: /app/worker (this directory). Tests read fixtures from /app/contracts,
# which is mounted at run time (-v "$PWD/contracts:/app/contracts:ro").
WORKDIR /app/worker

COPY pyproject.toml ./
RUN mkdir mosaic_worker && touch mosaic_worker/__init__.py \
 && pip install --no-cache-dir -e ".[dev]"

COPY scripts ./scripts
RUN sh scripts/fetch_model.sh

COPY mosaic_worker ./mosaic_worker
COPY tests ./tests
# Cache the sample face image for integration tests (tests also fetch it on demand and skip if offline).
RUN mkdir -p tests/assets && (curl -fL --retry 2 -o tests/assets/face.jpg https://raw.githubusercontent.com/opencv/opencv/4.x/samples/data/lena.jpg || rm -f tests/assets/face.jpg)

CMD ["python", "-m", "mosaic_worker.main"]
