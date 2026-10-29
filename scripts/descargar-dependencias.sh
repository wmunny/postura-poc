#!/usr/bin/env bash
# Descarga el motor de MediaPipe Tasks Vision, los modelos Pose Landmarker y mp4-muxer a ./vendor
# para publicar la PoC sin depender de CDNs. Después: USE_LOCAL_ASSETS = true en js/config.js
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(sed -n "s/.*TASKS_VISION_VERSION = '\([^']*\)'.*/\1/p" js/config.js)"
echo "MediaPipe Tasks Vision ${VERSION}"

mkdir -p vendor/tasks-vision vendor/models
TMP="$(mktemp -d)"
( cd "$TMP" && npm pack "@mediapipe/tasks-vision@${VERSION}" --silent >/dev/null && tar xzf ./*.tgz )
cp "$TMP/package/vision_bundle.mjs" vendor/tasks-vision/
cp -r "$TMP/package/wasm" vendor/tasks-vision/
rm -rf "$TMP"

for m in lite full heavy; do
  echo "Modelo ${m}…"
  curl -fL --progress-bar -o "vendor/models/pose_landmarker_${m}.task" \
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/1/pose_landmarker_${m}.task"
done

MUXER="$(sed -n "s/.*MP4_MUXER_VERSION = '\([^']*\)'.*/\1/p" js/config.js)"
echo "mp4-muxer ${MUXER}…"
mkdir -p vendor/mp4-muxer
curl -fL --progress-bar -o vendor/mp4-muxer/mp4-muxer.mjs \
  "https://cdn.jsdelivr.net/npm/mp4-muxer@${MUXER}/build/mp4-muxer.mjs"

du -sh vendor
echo "Listo. Pon USE_LOCAL_ASSETS = true en js/config.js"
