#!/usr/bin/env bash
# Rename a track filename in the database (does not rename on disk).
# Usage: DEPLOY_HOST=you@server ./deploy/k3s/rename-track.sh old-name.mp3 new-name.mp3
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

OLD="${1:-}"
NEW="${2:-}"

if [[ -z "$OLD" || -z "$NEW" ]]; then
  echo "Usage: DEPLOY_HOST=user@server $0 old-name.mp3 new-name.mp3" >&2
  exit 1
fi

IMAGE="$(remote_kubectl -n iff-audio get deploy iff-api -o jsonpath='{.spec.template.spec.containers[0].image}')"

remote_kubectl -n iff-audio delete pod iff-rename-track --ignore-not-found
remote_kubectl -n iff-audio run iff-rename-track --rm -it --restart=Never \
  --image="$IMAGE" \
  --overrides="{
    \"spec\": {
      \"containers\": [{
        \"name\": \"iff-rename-track\",
        \"image\": \"$IMAGE\",
        \"workingDir\": \"/app\",
        \"command\": [\"npm\", \"run\", \"rename-track\", \"-w\", \"api\", \"--\", \"$OLD\", \"$NEW\"],
        \"env\": [
          {\"name\": \"LIBRARY_PATH\", \"value\": \"/library\"}
        ],
        \"envFrom\": [{\"secretRef\": {\"name\": \"iff-api\"}}],
        \"volumeMounts\": [{
          \"name\": \"library\",
          \"mountPath\": \"/library\"
        }]
      }],
      \"volumes\": [{
        \"name\": \"library\",
        \"persistentVolumeClaim\": {\"claimName\": \"iff-library\"}
      }]
    }
  }"
