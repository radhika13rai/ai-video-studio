#!/usr/bin/env bash
# Uploads the FFmpeg.wasm core to R2 (it's over the 25 MiB Workers static-asset limit).
# Usage: upload-ffmpeg-core.sh --local | --remote   (run from workers/api)
set -euo pipefail
where="${1:---local}"
version=$(node -p "require('../../renderer/node_modules/@ffmpeg/core/package.json').version")
src="../../renderer/node_modules/@ffmpeg/core/dist/esm"
for f in ffmpeg-core.js ffmpeg-core.wasm; do
  type=$([ "${f##*.}" = wasm ] && echo application/wasm || echo text/javascript)
  pnpm exec wrangler r2 object put "ai-video-studio-media/vendor/ffmpeg-core/${version}/${f}" \
    --file "${src}/${f}" --content-type "$type" "$where"
done
echo "Uploaded FFmpeg core ${version} (${where#--})."
