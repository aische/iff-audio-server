#!/usr/bin/env bash
# Shared deploy helpers; requires DEPLOY_HOST.

deploy_host() {
  if [[ -z "${DEPLOY_HOST:-}" ]]; then
    echo "set DEPLOY_HOST=user@your-server" >&2
    exit 1
  fi
  printf '%s' "$DEPLOY_HOST"
}

# Run kubectl on the k3s node over SSH (no local kubeconfig).
# Allocates a TTY when stdin/stdout are terminals (for kubectl run -it).
remote_kubectl() {
  local host
  host="$(deploy_host)"
  # Avoid empty-array + set -u on macOS Bash 3.2.
  # shellcheck disable=SC2029
  if [[ -t 0 && -t 1 ]]; then
    ssh -t "$host" "sudo k3s kubectl $(printf '%q ' "$@")"
  else
    ssh "$host" "sudo k3s kubectl $(printf '%q ' "$@")"
  fi
}

# Public URL prefix from site.yaml web Ingress (e.g. /apppath). No trailing slash.
site_public_base() {
  local site="${1:-deploy/k3s/site.yaml}"
  local base
  base="$(
    awk '
      $0 ~ /^[[:space:]]*name:[[:space:]]*iff-audio-web[[:space:]]*$/ { in_web = 1 }
      in_web && $0 ~ /path:[[:space:]]*\// {
        sub(/.*path:[[:space:]]*/, "")
        sub(/[[:space:]]+$/, "")
        print
        exit
      }
    ' "$site"
  )"
  if [[ -z "$base" || "$base" != /* || "$base" == "/" ]]; then
    echo "site.yaml: could not read web Ingress path (expected path: /your-prefix under iff-audio-web)" >&2
    exit 1
  fi
  base="${base%/}"
  printf '%s' "$base"
}

# Ingress host from site.yaml web Ingress.
site_ingress_host() {
  local site="${1:-deploy/k3s/site.yaml}"
  local h
  h="$(
    awk '
      $0 ~ /^[[:space:]]*name:[[:space:]]*iff-audio-web[[:space:]]*$/ { in_web = 1 }
      in_web && $0 ~ /host:[[:space:]]*/ {
        sub(/.*host:[[:space:]]*/, "")
        sub(/[[:space:]]+$/, "")
        print
        exit
      }
    ' "$site"
  )"
  if [[ -z "$h" ]]; then
    echo "site.yaml: could not read web Ingress host" >&2
    exit 1
  fi
  printf '%s' "$h"
}

# Ensure API Ingress path matches ${base}/api(/|$)(.*)
site_validate_paths() {
  local site="${1:-deploy/k3s/site.yaml}"
  local base needle
  base="$(site_public_base "$site")"
  needle="path: ${base}/api(/|\$)(.*)"
  if ! grep -qF "$needle" "$site"; then
    echo "site.yaml: API Ingress path must be exactly:" >&2
    echo "  ${needle}" >&2
    exit 1
  fi
}
