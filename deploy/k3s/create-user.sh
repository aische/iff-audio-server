#!/usr/bin/env bash
# Create a first user against the in-cluster database via a one-off pod.
# Usage: DEPLOY_HOST=you@server ./deploy/k3s/create-user.sh you@example.com 'your-password'
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

EMAIL="${1:-}"
PASSWORD="${2:-}"

if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
  echo "Usage: DEPLOY_HOST=user@server $0 email@example.com 'password'" >&2
  exit 1
fi

IMAGE="$(remote_kubectl -n iff-audio get deploy iff-api -o jsonpath='{.spec.template.spec.containers[0].image}')"

remote_kubectl -n iff-audio delete pod iff-create-user --ignore-not-found
remote_kubectl -n iff-audio run iff-create-user --rm -it --restart=Never \
  --image="$IMAGE" \
  --overrides="{
    \"spec\": {
      \"containers\": [{
        \"name\": \"iff-create-user\",
        \"image\": \"$IMAGE\",
        \"workingDir\": \"/app\",
        \"command\": [\"npm\", \"run\", \"create-user\", \"-w\", \"api\", \"--\", \"$EMAIL\", \"$PASSWORD\"],
        \"envFrom\": [{\"secretRef\": {\"name\": \"iff-api\"}}]
      }]
    }
  }"
