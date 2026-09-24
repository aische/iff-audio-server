#!/usr/bin/env bash
# Sync the library volume into the database via a one-off pod.
# Usage: DEPLOY_HOST=you@server ./deploy/k3s/sync-library.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

IMAGE="$(remote_kubectl -n iff-audio get deploy iff-api -o jsonpath='{.spec.template.spec.containers[0].image}')"

remote_kubectl -n iff-audio delete pod iff-sync-library --ignore-not-found
remote_kubectl -n iff-audio run iff-sync-library --rm -it --restart=Never \
  --image="$IMAGE" \
  --overrides="{
    \"spec\": {
      \"containers\": [{
        \"name\": \"iff-sync-library\",
        \"image\": \"$IMAGE\",
        \"workingDir\": \"/app\",
        \"command\": [\"npm\", \"run\", \"sync-library\", \"-w\", \"api\"],
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
