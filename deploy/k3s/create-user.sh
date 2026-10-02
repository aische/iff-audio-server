#!/usr/bin/env bash
# Create a user (or reset password with --reset) against the in-cluster database via a one-off pod.
# Usage: DEPLOY_HOST=you@server ./deploy/k3s/create-user.sh you@example.com 'your-password' [--reset]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

RESET=false
POSITIONAL=()
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=true ;;
    *) POSITIONAL+=("$arg") ;;
  esac
done

EMAIL="${POSITIONAL[0]:-}"
PASSWORD="${POSITIONAL[1]:-}"

if [[ -z "$EMAIL" || -z "$PASSWORD" || ${#POSITIONAL[@]} -ne 2 ]]; then
  echo "Usage: DEPLOY_HOST=user@server $0 email@example.com 'password' [--reset]" >&2
  exit 1
fi

COMMAND_JSON="[\"npm\", \"run\", \"create-user\", \"-w\", \"api\", \"--\", \"$EMAIL\", \"$PASSWORD\""
if [[ "$RESET" == true ]]; then
  COMMAND_JSON+=", \"--reset\""
fi
COMMAND_JSON+="]"

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
        \"command\": $COMMAND_JSON,
        \"envFrom\": [{\"secretRef\": {\"name\": \"iff-api\"}}]
      }]
    }
  }"
