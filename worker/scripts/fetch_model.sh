#!/bin/sh
# Download the YuNet face detection model into worker/models/ (skipped if present).
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
FILE="$DIR/face_detection_yunet_2023mar.onnx"
URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
mkdir -p "$DIR"
if [ -s "$FILE" ]; then
  echo "model already present: $FILE"
else
  curl -fL --retry 3 -o "$FILE.tmp" "$URL"
  mv "$FILE.tmp" "$FILE"
  echo "downloaded: $FILE"
fi

# NanoDet person detector (person gate, mosaic_worker/person.py)
PFILE="$DIR/object_detection_nanodet_2022nov.onnx"
PURL="https://github.com/opencv/opencv_zoo/raw/main/models/object_detection_nanodet/object_detection_nanodet_2022nov.onnx"
if [ -s "$PFILE" ]; then
  echo "model already present: $PFILE"
else
  curl -fL --retry 3 -o "$PFILE.tmp" "$PURL"
  mv "$PFILE.tmp" "$PFILE"
  echo "downloaded: $PFILE"
fi
