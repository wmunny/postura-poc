#!/usr/bin/env bash
# Descarga el motor de MediaPipe Tasks Vision y los modelos Pose Landmarker a ./vendor
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

du -sh vendor
echo "Listo. Pon USE_LOCAL_ASSETS = true en js/config.js"
