#!/usr/bin/env bash
# Database backups: create, list, download, restore to the server, mirror to local.
# See deploy-k3s.md, "Database backups".
#
# Usage:
#   export DEPLOY_HOST=you@your-server
#   ./deploy/k3s/db.sh backup [--download] [label]
#   ./deploy/k3s/db.sh list
#   ./deploy/k3s/db.sh pull <name>
#   ./deploy/k3s/db.sh restore <name | path/to/file.dump>
#   ./deploy/k3s/db.sh mirror [--with-mp3s] [name | path/to/file.dump]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

NS=iff-audio
SERVER_BACKUP_DIR="${SERVER_BACKUP_DIR:-/var/backups/iff-audio}"
LOCAL_BACKUP_DIR="$ROOT/backups"
COMPOSE_FILE="$ROOT/deploy/docker-compose.yml"
LOCAL_JOURNAL="$ROOT/packages/db/drizzle/meta/_journal.json"
SERVER_JOURNAL=/app/packages/db/drizzle/meta/_journal.json
# Where a dump is staged inside the postgres container before inspecting/restoring it.
STAGED=/tmp/iff-restore.dump
# Runs inside the postgres container. Session rows are skipped: they are signed
# with the source's SESSION_SECRET and useless elsewhere (restore = log in again).
DUMP_SH='pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl --exclude-table-data=sessions'

HOST=""
TARGET="" # server | local — which postgres `pg` / `pg_in` talk to
STAGED_ON="" # set once a dump is staged, for cleanup
API_DOWN=0

die() {
  echo "error: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<EOF
Usage: $0 <command>

  backup [--download] [label]   Dump the server DB into $SERVER_BACKUP_DIR on the server
                                (--download: also copy it to ./backups/)
  list                          List server and local backups
  pull <name>                   Copy a server backup to ./backups/
  restore <name | file.dump>    Replace the SERVER DB with a server backup or a local file
  mirror [--with-mp3s] [name | file.dump]
                                Replace the LOCAL DB with a fresh server backup (default),
                                a server backup, or a local file. --with-mp3s also copies
                                MP3s missing locally from the server.

Needs DEPLOY_HOST=user@server (except mirror from a local file).
SERVER_BACKUP_DIR overrides the server backup folder.
EOF
  exit 1
}

need_host() {
  [[ -n "$HOST" ]] || HOST="$(deploy_host)"
  [[ "$SERVER_BACKUP_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "SERVER_BACKUP_DIR must be an absolute path"
}

valid_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.dump$ ]] || die "not a backup name: $1 (expected *.dump)"
}

backup_name() { # origin [label]
  local name
  name="iff-$1-$(date +%Y%m%d-%H%M%S)"
  if [[ -n "${2:-}" ]]; then
    [[ "$2" =~ ^[A-Za-z0-9_-]+$ ]] || die "label may only contain letters, digits, - and _"
    name+="-$2"
  fi
  printf '%s.dump' "$name"
}

origin_of() { # name -> server | local | unknown
  case "$1" in
    iff-server-*) echo server ;;
    iff-local-*) echo local ;;
    *) echo unknown ;;
  esac
}

confirm() { # phrase
  local answer=""
  printf '\nType "%s" to continue (anything else aborts): ' "$1" >&2
  if { exec 3</dev/tty; } 2>/dev/null; then
    read -r answer <&3 || true
    exec 3<&-
  else
    read -r answer || true
  fi
  [[ "$answer" == "$1" ]] || die "aborted, nothing was changed"
}

# --- remote / container plumbing --------------------------------------------

# Run a bash script (stdin) on the server with positional args.
# Scripts wrap their body in main() so nothing inside reads the script's stdin.
remote_bash() {
  ssh "$HOST" "bash -s -- $(printf '%q ' "$@")"
}

kc() {
  ssh -n "$HOST" "sudo k3s kubectl -n $NS $(printf '%q ' "$@")"
}

# Run a command in the target postgres container (no stdin / with stdin).
pg() {
  if [[ "$TARGET" == server ]]; then
    ssh -n "$HOST" "sudo k3s kubectl -n $NS exec deploy/iff-postgres -- $(printf '%q ' "$@")"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres "$@" </dev/null
  fi
}

pg_in() {
  if [[ "$TARGET" == server ]]; then
    ssh "$HOST" "sudo k3s kubectl -n $NS exec -i deploy/iff-postgres -- $(printf '%q ' "$@")"
  else
    docker compose -f "$COMPOSE_FILE" exec -T postgres "$@"
  fi
}

cleanup() {
  local rc=$?
  if [[ "$API_DOWN" == 1 ]]; then
    echo "Starting the API again..." >&2
    kc scale deploy/iff-api --replicas=1 >/dev/null ||
      echo "could not scale the API back up; run: kubectl -n $NS scale deploy/iff-api --replicas=1" >&2
  fi
  if [[ -n "$STAGED_ON" ]]; then
    TARGET="$STAGED_ON"
    pg rm -f "$STAGED" >/dev/null 2>&1 || true
  fi
  exit "$rc"
}
trap cleanup EXIT

# --- backups ----------------------------------------------------------------

server_exists() { # name
  ssh -n "$HOST" "sudo test -f $(printf '%q' "$SERVER_BACKUP_DIR/$1")"
}

server_sha() { # name
  ssh -n "$HOST" "sudo sha256sum $(printf '%q' "$SERVER_BACKUP_DIR/$1")" | awk '{print $1}'
}

local_sha() { # file
  shasum -a 256 "$1" | awk '{print $1}'
}

# Dump the server DB into SERVER_BACKUP_DIR. Sets BACKUP_NAME.
server_backup() { # [label]
  BACKUP_NAME="$(backup_name server "${1:-}")"
  echo "Creating server backup $BACKUP_NAME..." >&2
  remote_bash "$SERVER_BACKUP_DIR" "$BACKUP_NAME" "$NS" "$DUMP_SH" <<'EOF'
main() {
  set -euo pipefail
  local dir=$1 name=$2 ns=$3 dump=$4
  local tmp="$dir/.$name.partial"
  sudo mkdir -p "$dir"
  sudo chmod 700 "$dir"
  if sudo test -e "$dir/$name"; then
    echo "already exists on server: $dir/$name" >&2
    exit 1
  fi
  sudo install -m 600 /dev/null "$tmp"
  if ! sudo k3s kubectl -n "$ns" exec deploy/iff-postgres -- sh -c "$dump" </dev/null |
    sudo tee "$tmp" >/dev/null; then
    sudo rm -f "$tmp"
    echo "pg_dump failed" >&2
    exit 1
  fi
  if ! sudo test -s "$tmp"; then
    sudo rm -f "$tmp"
    echo "pg_dump produced an empty file" >&2
    exit 1
  fi
  sudo mv "$tmp" "$dir/$name"
}
main "$@"
EOF
  echo "  -> $HOST:$SERVER_BACKUP_DIR/$BACKUP_NAME" >&2
}

# Dump the local DB into ./backups. Sets BACKUP_FILE.
local_backup() { # [label]
  local name tmp
  name="$(backup_name local "${1:-}")"
  BACKUP_FILE="$LOCAL_BACKUP_DIR/$name"
  tmp="$LOCAL_BACKUP_DIR/.$name.partial"
  echo "Creating local backup $name..." >&2
  mkdir -p "$LOCAL_BACKUP_DIR"
  chmod 700 "$LOCAL_BACKUP_DIR"
  if ! (umask 077 && pg sh -c "$DUMP_SH" >"$tmp") || [[ ! -s "$tmp" ]]; then
    rm -f "$tmp"
    die "local pg_dump failed"
  fi
  mv "$tmp" "$BACKUP_FILE"
  echo "  -> ${BACKUP_FILE#"$ROOT"/}" >&2
}

# Copy a server backup to ./backups (sha256-checked). Sets BACKUP_FILE.
download() { # name
  local name=$1 tmp
  BACKUP_FILE="$LOCAL_BACKUP_DIR/$name"
  tmp="$LOCAL_BACKUP_DIR/.$name.partial"
  [[ ! -e "$BACKUP_FILE" ]] || die "already exists locally: ${BACKUP_FILE#"$ROOT"/}"
  mkdir -p "$LOCAL_BACKUP_DIR"
  chmod 700 "$LOCAL_BACKUP_DIR"
  echo "Downloading $name..." >&2
  if ! (umask 077 && ssh -n "$HOST" "sudo cat $(printf '%q' "$SERVER_BACKUP_DIR/$name")" >"$tmp"); then
    rm -f "$tmp"
    die "download failed"
  fi
  if [[ "$(server_sha "$name")" != "$(local_sha "$tmp")" ]]; then
    rm -f "$tmp"
    die "download corrupted (sha256 mismatch)"
  fi
  mv "$tmp" "$BACKUP_FILE"
  echo "  -> ${BACKUP_FILE#"$ROOT"/}" >&2
}

# Copy a local file into SERVER_BACKUP_DIR (keeps a record of what was applied).
upload() { # file name
  local file=$1 name=$2
  if server_exists "$name"; then
    return 0
  fi
  echo "Copying $name to the server backups..." >&2
  remote_bash "$SERVER_BACKUP_DIR" "$name" <<'EOF' || die "upload failed"
main() {
  set -euo pipefail
  sudo mkdir -p "$1"
  sudo chmod 700 "$1"
  sudo install -m 600 /dev/null "$1/.$2.partial"
}
main "$@"
EOF
  ssh "$HOST" "sudo tee $(printf '%q' "$SERVER_BACKUP_DIR/.$name.partial") >/dev/null" <"$file" ||
    die "upload failed"
  ssh -n "$HOST" "sudo mv $(printf '%q' "$SERVER_BACKUP_DIR/.$name.partial") $(printf '%q' "$SERVER_BACKUP_DIR/$name")"
  [[ "$(server_sha "$name")" == "$(local_sha "$file")" ]] || die "upload corrupted (sha256 mismatch)"
}

# --- inspecting a dump ------------------------------------------------------

stage_server_backup() { # name
  STAGED_ON="$TARGET"
  remote_bash "$SERVER_BACKUP_DIR/$1" "$NS" "$STAGED" <<'EOF'
main() {
  set -euo pipefail
  sudo cat "$1" | sudo k3s kubectl -n "$2" exec -i deploy/iff-postgres -- sh -c "umask 077; cat > $3"
}
main "$@"
EOF
}

stage_file() { # file
  STAGED_ON="$TARGET"
  pg_in sh -c "umask 077; cat > $STAGED" <"$1"
}

# Reads the dump's data as SQL text; prints key=value lines.
SUMMARY_AWK='
function colindex(line, want,   hdr, n, cols, i) {
  hdr = line
  sub(/^[^(]*\(/, "", hdr)
  sub(/\).*$/, "", hdr)
  n = split(hdr, cols, /, */)
  for (i = 1; i <= n; i++) if (cols[i] == want) return i
  return 0
}
/^COPY / {
  tbl = $2; inside = 1; rows[tbl] = 0
  if (tbl == "public.users") emailcol = colindex($0, "email")
  if (tbl == "drizzle.__drizzle_migrations") whencol = colindex($0, "created_at")
  next
}
inside && $0 == "\\." { inside = 0; next }
inside {
  rows[tbl]++
  split($0, f, "\t")
  if (tbl == "public.users" && emailcol) emails = emails (emails == "" ? "" : ", ") f[emailcol]
  if (tbl == "drizzle.__drizzle_migrations" && whencol && f[whencol] + 0 > latest) latest = f[whencol] + 0
}
END {
  printf "users=%d\ntracks=%d\ncomments=%d\narrangements=%d\n", rows["public.users"], rows["public.tracks"], rows["public.comments"], rows["public.arrangements"]
  printf "migrations=%d\nlatest=%.0f\nemails=%s\n", rows["drizzle.__drizzle_migrations"], latest, emails
}'

# Sets D_USERS D_TRACKS D_COMMENTS D_ARRANGEMENTS D_MIGRATIONS D_LATEST D_EMAILS.
inspect_staged() {
  pg pg_restore -l "$STAGED" >/dev/null 2>&1 || die "not a valid pg_dump custom-format file"
  local summary k v
  summary="$(pg pg_restore -a -f - "$STAGED" | awk "$SUMMARY_AWK")" || die "could not read the backup"
  while IFS='=' read -r k v; do
    case "$k" in
      users) D_USERS=$v ;;
      tracks) D_TRACKS=$v ;;
      comments) D_COMMENTS=$v ;;
      arrangements) D_ARRANGEMENTS=$v ;;
      migrations) D_MIGRATIONS=$v ;;
      latest) D_LATEST=$v ;;
      emails) D_EMAILS=$v ;;
    esac
  done <<<"$summary"
  [[ "$D_MIGRATIONS" -gt 0 ]] || die "backup has no drizzle migrations table; not an iff-audio database"
}

# Sets C_MIGRATIONS C_LATEST from a drizzle journal on stdin.
read_journal() {
  local out
  out="$(node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const e = JSON.parse(s).entries;
      console.log(e.length + " " + e[e.length - 1].when);
    });
  ')" || die "could not read the migration journal"
  read -r C_MIGRATIONS C_LATEST <<<"$out"
}

current_counts() {
  pg sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " " -c "select (select count(*) from users), (select count(*) from tracks), (select count(*) from comments), (select count(*) from arrangements)"' 2>/dev/null |
    awk '{ printf "%s users, %s tracks, %s comments, %s arrangements", $1, $2, $3, $4 }' ||
    true
}

check_schema() { # where-code-lives
  if [[ "$D_LATEST" -gt "$C_LATEST" ]]; then
    die "the backup's schema ($D_MIGRATIONS migrations) is newer than the $1 ($C_MIGRATIONS migrations); deploy / check out newer code first"
  fi
}

describe() { # label-of-backup where-code-lives
  local code_where=$2 schema
  schema="$D_MIGRATIONS migrations ($code_where has $C_MIGRATIONS)"
  if [[ "$D_LATEST" -lt "$C_LATEST" ]]; then
    schema+=" — the missing ones are applied after the restore"
  fi
  cat >&2 <<EOF

  Backup:    $1
  Contains:  $D_USERS users, $D_TRACKS tracks, $D_COMMENTS comments, $D_ARRANGEMENTS arrangements
  Users:     ${D_EMAILS:-(none)}
  Schema:    $schema
EOF
}

# --- restoring ----------------------------------------------------------------

db_name() {
  local n
  n="$(pg sh -c 'printf %s "$POSTGRES_DB"')"
  [[ "$n" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "unexpected POSTGRES_DB: $n"
  printf '%s' "$n"
}

# Restore the staged dump into <db>_restore. The live DB is not touched.
restore_into_temp() {
  echo "Restoring into a temporary database..." >&2
  if ! pg sh -c 'export PGOPTIONS="-c client_min_messages=warning"; t="${POSTGRES_DB}_restore"; dropdb -U "$POSTGRES_USER" --if-exists --force "$t" && createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$t" && pg_restore -U "$POSTGRES_USER" -d "$t" --no-owner --no-acl --exit-on-error --single-transaction '"$STAGED"; then
    pg sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "${POSTGRES_DB}_restore"' >/dev/null 2>&1 || true
    die "restore failed; the live database was not changed"
  fi
}

# Swap <db>_restore in as <db>, then drop the old one.
swap_in_restored() {
  local db attempt
  db="$(db_name)"
  echo "Swapping databases..." >&2
  local sql="
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname IN ('$db', '${db}_restore') AND pid <> pg_backend_pid();
SELECT pg_sleep(0.5);
DROP DATABASE IF EXISTS \"${db}_old\" WITH (FORCE);
BEGIN;
ALTER DATABASE \"$db\" RENAME TO \"${db}_old\";
ALTER DATABASE \"${db}_restore\" RENAME TO \"$db\";
COMMIT;
"
  for attempt in 1 2 3 4 5; do
    if printf '%s' "$sql" | pg_in sh -c 'PGOPTIONS="-c client_min_messages=warning" psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -q -o /dev/null'; then
      pg sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "${POSTGRES_DB}_old"' ||
        echo "warning: could not drop ${db}_old; drop it by hand" >&2
      return 0
    fi
    echo "  swap attempt $attempt failed (database busy?), retrying..." >&2
    sleep 1
  done
  die "could not swap databases; the live database was not changed (restored copy left in ${db}_restore)"
}

# --- commands -------------------------------------------------------------------

cmd_backup() {
  local download_too=0 label=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --download) download_too=1 ;;
      -*) usage ;;
      *) [[ -z "$label" ]] || usage; label=$1 ;;
    esac
    shift
  done
  need_host
  server_backup "$label"
  if [[ "$download_too" == 1 ]]; then
    download "$BACKUP_NAME"
  fi
}

cmd_list() {
  need_host
  echo "Server ($HOST:$SERVER_BACKUP_DIR):"
  ssh -n "$HOST" "sudo find $(printf '%q' "$SERVER_BACKUP_DIR") -maxdepth 1 -type f -name '*.dump' -printf '%s %f\n' 2>/dev/null || true" |
    sort -k2 | awk '{ printf "  %8.1f MB  %s\n", $1 / 1048576, $2 } END { if (NR == 0) print "  (none)" }'
  echo "Local (backups/):"
  if [[ -d "$LOCAL_BACKUP_DIR" ]]; then
    find "$LOCAL_BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -exec ls -l {} + 2>/dev/null |
      awk '{ n = $NF; sub(/.*\//, "", n); printf "  %8.1f MB  %s\n", $5 / 1048576, n }' | sort -k3
  fi | awk '{ print } END { if (NR == 0) print "  (none)" }'
}

cmd_pull() {
  [[ $# -eq 1 ]] || usage
  valid_name "$1"
  need_host
  server_exists "$1" || die "no such server backup: $1 (see: $0 list)"
  download "$1"
}

cmd_restore() {
  [[ $# -eq 1 ]] || usage
  local arg=$1 name file="" source origin phrase current
  need_host
  TARGET=server
  if [[ -f "$arg" ]]; then
    file=$arg
    name="$(basename "$file")"
    valid_name "$name"
    if server_exists "$name" && [[ "$(server_sha "$name")" != "$(local_sha "$file")" ]]; then
      die "a different server backup is already called $name; rename the local file"
    fi
    source="$file (local file)"
    echo "Uploading $name to the postgres pod for inspection..." >&2
    stage_file "$file"
  else
    name=$arg
    valid_name "$name"
    server_exists "$name" || die "no such server backup: $name (see: $0 list)"
    source="$name (on the server)"
    stage_server_backup "$name"
  fi
  origin="$(origin_of "$name")"

  inspect_staged
  local journal
  journal="$(kc exec deploy/iff-api -c api -- cat "$SERVER_JOURNAL")" ||
    die "could not read the deployed code's migrations (is the API running?)"
  read_journal <<<"$journal"
  check_schema "deployed code"
  current="$(current_counts)"

  echo >&2
  echo "RESTORE A BACKUP INTO THE SERVER DATABASE ($HOST)" >&2
  describe "$source" "deployed code"
  echo "  Server DB: ${current:-unknown}" >&2
  if [[ "$origin" != server ]]; then
    cat >&2 <<EOF

  WARNING: this backup was $([[ "$origin" == local ]] && echo "made from a LOCAL database" || echo "not named iff-server-*, so its origin is unknown").
  It replaces the server's users and passwords with the ones listed above, and
  tracks that exist only in that database will show up as "missing" on the server.
EOF
  fi
  cat >&2 <<EOF

What happens:
  1. A safety backup of the current server DB is written to $SERVER_BACKUP_DIR (…-pre-restore).
EOF
  [[ -z "$file" ]] || echo "     The local file is also copied there, as a record." >&2
  cat >&2 <<EOF
  2. The backup is restored into a temporary database (if that fails, nothing changes).
  3. The API is stopped (site down for some seconds), the databases are swapped,
     and the old one is dropped.
  4. The API starts again and applies pending migrations. Everyone must log in again.
  5. sync-library runs, so the "missing" flags match the server's MP3 folder.

Everything written to the server since the backup was made — comments, tags,
arrangements, releases, users, passwords — is LOST (apart from the safety backup).
EOF
  if [[ "$origin" == server ]]; then
    phrase="restore ${HOST#*@}"
  else
    phrase="overwrite ${HOST#*@} with $origin backup"
  fi
  confirm "$phrase"

  [[ -z "$file" ]] || upload "$file" "$name"
  server_backup pre-restore
  restore_into_temp

  echo "Stopping the API..." >&2
  API_DOWN=1
  kc scale deploy/iff-api --replicas=0 >/dev/null
  kc wait --for=delete pod -l app=iff-api --timeout=120s >/dev/null 2>&1 || true
  swap_in_restored

  echo "Starting the API (runs migrations)..." >&2
  kc scale deploy/iff-api --replicas=1 >/dev/null
  API_DOWN=0
  kc rollout status deploy/iff-api --timeout=300s
  kc logs deploy/iff-api -c migrate --tail=20 || true

  echo "Syncing the library..." >&2
  "$SCRIPT_DIR/sync-library.sh"

  echo >&2
  echo "Restored $name. Safety backup of the previous DB: $BACKUP_NAME" >&2
}

local_library_path() {
  local raw=""
  [[ -f "$ROOT/.env" ]] && raw="$(sed -n 's/^LIBRARY_PATH=//p' "$ROOT/.env" | tail -n 1)"
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  [[ -n "$raw" ]] || die "LIBRARY_PATH is not set in .env"
  [[ "$raw" == /* ]] || raw="$ROOT/$raw"
  printf '%s' "$raw"
}

cmd_mirror() {
  local with_mp3s=0 arg="" file source origin current server_lib="" local_lib=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-mp3s) with_mp3s=1 ;;
      -*) usage ;;
      *) [[ -z "$arg" ]] || usage; arg=$1 ;;
    esac
    shift
  done

  TARGET=local
  pg pg_isready -q >/dev/null 2>&1 ||
    die "local postgres is not running (docker compose -f deploy/docker-compose.yml up -d)"
  if [[ "$with_mp3s" == 1 ]]; then
    need_host
    [[ -f "$SCRIPT_DIR/site.yaml" ]] || die "--with-mp3s needs deploy/k3s/site.yaml (for the server MP3 folder)"
    server_lib="$(site_library_host_path "$SCRIPT_DIR/site.yaml")"
    local_lib="$(local_library_path)"
  fi

  if [[ -z "$arg" ]]; then
    need_host
    server_backup mirror
    download "$BACKUP_NAME"
    file=$BACKUP_FILE
  elif [[ -f "$arg" ]]; then
    file=$arg
  else
    valid_name "$arg"
    if [[ -f "$LOCAL_BACKUP_DIR/$arg" ]]; then
      file="$LOCAL_BACKUP_DIR/$arg"
    else
      need_host
      server_exists "$arg" || die "no such backup locally or on the server: $arg"
      download "$arg"
      file=$BACKUP_FILE
    fi
  fi
  source="${file#"$ROOT"/}"
  origin="$(origin_of "$(basename "$file")")"

  stage_file "$file"
  inspect_staged
  read_journal <"$LOCAL_JOURNAL"
  check_schema "local code"
  current="$(current_counts)"

  echo >&2
  echo "REPLACE YOUR LOCAL DATABASE WITH A BACKUP" >&2
  describe "$source ($origin)" "local code"
  echo "  Local DB:  ${current:-unknown}" >&2
  cat >&2 <<EOF

What happens:
  1. A safety backup of your local DB is written to backups/ (iff-local-…-pre-mirror).
  2. The backup is restored into a temporary database, then swapped in for the
     local one (open connections, e.g. npm run dev, are dropped and reconnect).
EOF
  if [[ "$with_mp3s" == 1 ]]; then
    echo "  3. MP3s missing in $local_lib are copied from $HOST:$server_lib (existing files are left alone)." >&2
  fi
  cat >&2 <<EOF
  $([[ "$with_mp3s" == 1 ]] && echo 4 || echo 3). Migrations run, then sync-library: tracks without a local MP3 show as "missing",
     local-only MP3s are added as new tracks.

All local comments, tags, arrangements, releases and users are replaced; you log in
with the passwords from the backup.
EOF
  confirm "replace local db"

  local_backup pre-mirror
  local safety=$BACKUP_FILE
  restore_into_temp
  swap_in_restored

  if [[ "$with_mp3s" == 1 ]]; then
    echo "Copying missing MP3s..." >&2
    mkdir -p "$local_lib"
    rsync -rtv --ignore-existing --include='*.mp3' --exclude='*' \
      --rsync-path='sudo rsync' "$HOST:$server_lib/" "$local_lib/"
  fi

  echo "Running migrations..." >&2
  (cd "$ROOT" && npm run migrate -w @iff/db)
  echo "Syncing the library..." >&2
  (cd "$ROOT" && npm run sync-library -w api)

  echo >&2
  echo "Local DB now mirrors $source. Safety backup of the previous local DB: ${safety#"$ROOT"/}" >&2
}

CMD="${1:-}"
[[ $# -gt 0 ]] && shift
case "$CMD" in
  backup) cmd_backup "$@" ;;
  list) cmd_list "$@" ;;
  pull) cmd_pull "$@" ;;
  restore) cmd_restore "$@" ;;
  mirror) cmd_mirror "$@" ;;
  *) usage ;;
esac
