#!/bin/sh
# Download the YuNet face detection model into worker/models/ (skipped if present).
set -eu
DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
FILE="$DIR/face_detection_yunet_2023mar.onnx"
URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
mkdir -p "$DIR"
if [ -s "$FILE" ]; then
  echo "model already present: $FILE"
  exit 0
fi
curl -fL --retry 3 -o "$FILE.tmp" "$URL"
mv "$FILE.tmp" "$FILE"
echo "downloaded: $FILE"
