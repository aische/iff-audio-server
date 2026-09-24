#!/usr/bin/env bash
# upload | apply — needs DEPLOY_HOST and site.yaml; see deploy-k3s.md.
#
# Usage:
#   export DEPLOY_HOST=you@your-server
#   ./deploy/k3s/deploy.sh upload
#   ./deploy/k3s/deploy.sh apply
#   MIGRATE=1 ./deploy/k3s/deploy.sh apply
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${1:-}"
MIGRATE="${MIGRATE:-0}"

cd "$ROOT"

usage() {
  echo "Usage: $0 upload|apply" >&2
  echo "  both need DEPLOY_HOST (SSH with sudo for k3s)" >&2
  exit 1
}

require_site() {
  if [[ ! -f deploy/k3s/site.yaml ]]; then
    echo "missing deploy/k3s/site.yaml (copy from site.example.yaml)" >&2
    exit 1
  fi
  site_validate_paths deploy/k3s/site.yaml
}

# Substitute @BASE_PATH@ in web.yaml into a staging dir for rsync/apply.
stage_manifests() {
  local dest="$1"
  local base="$2"
  mkdir -p "$dest"
  # YAML only (includes gitignored site.yaml). Never copy Dockerfiles/scripts.
  local f
  for f in deploy/k3s/*.yaml; do
    case "$(basename "$f")" in
      web.yaml)
        sed "s|@BASE_PATH@|${base}|g" "$f" >"${dest}/web.yaml"
        ;;
      *)
        cp "$f" "$dest/"
        ;;
    esac
  done
}

do_upload() {
  require_site

  local host base
  host="$(deploy_host)"
  base="$(site_public_base deploy/k3s/site.yaml)"

  echo "Building images for public base ${base} (from site.yaml)..."
  docker build --platform linux/amd64 -f deploy/k3s/Dockerfile.api -t iff-api:local .
  docker build --platform linux/amd64 -f deploy/k3s/Dockerfile.web \
    --build-arg "PUBLIC_BASE=${base}" \
    --build-arg "VITE_BASE_PATH=${base}/" \
    --build-arg "VITE_API_URL=${base}/api" \
    -t iff-web:local .

  echo "Importing images on $host..."
  docker save iff-api:local iff-web:local \
    | gzip \
    | ssh "$host" 'gunzip | sudo k3s ctr images import -'

  echo "Images imported. Next: npm run deploy:k3s:apply"
}

do_apply() {
  require_site

  local host remote_dir base ingress_host stage
  host="$(deploy_host)"
  base="$(site_public_base deploy/k3s/site.yaml)"
  ingress_host="$(site_ingress_host deploy/k3s/site.yaml)"
  stage="$(mktemp -d "${TMPDIR:-/tmp}/iff-deploy.XXXXXX")"
  remote_dir="$(ssh "$host" 'mktemp -d /tmp/iff-deploy.XXXXXX')"

  cleanup() {
    rm -rf "$stage"
    ssh "$host" "rm -rf $(printf '%q' "$remote_dir")" || true
  }
  trap cleanup EXIT

  stage_manifests "$stage" "$base"

  echo "Syncing manifests to $host:$remote_dir (base ${base})..."
  rsync -az "${stage}/" "${host}:${remote_dir}/"

  echo "Applying on $host via k3s kubectl..."
  # shellcheck disable=SC2029
  ssh "$host" "set -euo pipefail
    DIR=$(printf '%q' "$remote_dir")
    sudo k3s kubectl apply -f \"\$DIR/namespace.yaml\"
    sudo k3s kubectl apply -f \"\$DIR/site.yaml\"
    sudo k3s kubectl apply -k \"\$DIR\"
    sudo k3s kubectl -n iff-audio rollout restart deploy/iff-api deploy/iff-web
    sudo k3s kubectl -n iff-audio rollout status deploy/iff-postgres
    sudo k3s kubectl -n iff-audio rollout status deploy/iff-api
    sudo k3s kubectl -n iff-audio rollout status deploy/iff-web
  "

  if [[ "$MIGRATE" == "1" ]]; then
    remote_kubectl -n iff-audio delete job iff-migrate --ignore-not-found
    # shellcheck disable=SC2029
    ssh "$host" "sudo k3s kubectl apply -f $(printf '%q' "$remote_dir")/migrate-job.yaml"
    remote_kubectl -n iff-audio wait --for=condition=complete job/iff-migrate --timeout=120s
    remote_kubectl -n iff-audio logs job/iff-migrate
  fi

  echo "Done. Smoke: curl -sS https://${ingress_host}${base}/api/health"
}

case "$MODE" in
  upload) do_upload ;;
  apply) do_apply ;;
  *) usage ;;
esac
