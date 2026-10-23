#!/usr/bin/env bash
# Create a user (or reset password with --reset) against the in-cluster database via a one-off pod.
# Usage: DEPLOY_HOST=you@server ./deploy/k3s/create-user.sh you@example.com [--reset]
# Prompts for the password (or reads the first line of stdin) and pipes it to the pod's stdin,
# so it never appears in the pod spec, `ps` or shell history.
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

if [[ -z "$EMAIL" || ${#POSITIONAL[@]} -ne 1 ]]; then
  echo "Usage: DEPLOY_HOST=user@server $0 email@example.com [--reset]" >&2
  exit 1
fi

if [[ -t 0 ]]; then
  read -rsp "Password: " PASSWORD
  echo >&2
  read -rsp "Repeat password: " PASSWORD2
  echo >&2
  if [[ "$PASSWORD" != "$PASSWORD2" ]]; then
    echo "Passwords do not match" >&2
    exit 1
  fi
else
  IFS= read -r PASSWORD || true
fi
if [[ -z "$PASSWORD" ]]; then
  echo "Password required" >&2
  exit 1
fi

COMMAND_JSON="[\"npm\", \"run\", \"-s\", \"create-user\", \"-w\", \"api\", \"--\", $(json_string "$EMAIL")"
if [[ "$RESET" == true ]]; then
  COMMAND_JSON+=", \"--reset\""
fi
COMMAND_JSON+="]"

IMAGE="$(remote_kubectl -n iff-audio get deploy iff-api -o jsonpath='{.spec.template.spec.containers[0].image}')"

remote_kubectl -n iff-audio delete pod iff-create-user --ignore-not-found
# Not a TTY (stdin is the pipe), so remote_kubectl won't allocate one; -i forwards the password.
printf '%s\n' "$PASSWORD" | remote_kubectl -n iff-audio run iff-create-user --rm -i --restart=Never \
  --image="$IMAGE" \
  --overrides="{
    \"spec\": {
      \"containers\": [{
        \"name\": \"iff-create-user\",
        \"image\": $(json_string "$IMAGE"),
        \"workingDir\": \"/app\",
        \"command\": $COMMAND_JSON,
        \"stdin\": true,
        \"stdinOnce\": true,
        \"envFrom\": [{\"secretRef\": {\"name\": \"iff-api\"}}]
      }]
    }
  }"
