# Deploy to k3s under `/apppath`

Run this app on a server where **Apache** proxies `/apppath/` into **k3s** (nginx Ingress).

| Public URL | Service |
| --- | --- |
| `https://<domain>/apppath/` | Web UI |
| `https://<domain>/apppath/api/*` | Fastify API |

Manifests and Dockerfiles live in [`deploy/k3s/`](./deploy/k3s/).

Site-specific values (secrets, MP3 host path, Ingress host and public subpath) live in gitignored `deploy/k3s/site.yaml` (from `site.example.yaml`). Never commit `site.yaml`, kubeconfigs, or `.env`.

---

## Prerequisites

- Docker (build images on your laptop)
- SSH to the k3s node with passwordless `sudo` for `k3s` / `k3s ctr` (no local kubeconfig required)
- `rsync` on the laptop (used by apply)
- nginx Ingress Controller (`ingressClassName: nginx`)
- Apache already forwarding `/apppath/` to the cluster **with the `/apppath` prefix intact**
- TLS at Apache (or Ingress); send `X-Forwarded-Proto: https`

---

## 1. Build images

`deploy:k3s:upload` reads the web Ingress path from `site.yaml` and builds the web image with matching `VITE_*` / nginx layout.

```bash
export DEPLOY_HOST=you@your-server
npm run deploy:k3s:upload
```

Manual equivalent (replace `/apppath` with your `site.yaml` web Ingress path):

```bash
docker build --platform linux/amd64 -f deploy/k3s/Dockerfile.api -t iff-api:local .
docker build --platform linux/amd64 -f deploy/k3s/Dockerfile.web \
  --build-arg PUBLIC_BASE=/apppath \
  --build-arg VITE_BASE_PATH=/apppath/ \
  --build-arg VITE_API_URL=/apppath/api \
  -t iff-web:local .
```

`npm run docker:build` uses the example `/apppath` defaults (local smoke only; production upload uses `site.yaml`).

### Push to a registry

```bash
export REGISTRY=ghcr.io/you   # or your registry
export TAG=1.0.0

docker tag iff-api:local "$REGISTRY/iff-api:$TAG"
docker tag iff-web:local "$REGISTRY/iff-web:$TAG"
docker push "$REGISTRY/iff-api:$TAG"
docker push "$REGISTRY/iff-web:$TAG"
```

Then set images in `deploy/k3s/kustomization.yaml`:

```yaml
images:
  - name: iff-api
    newName: ghcr.io/you/iff-api
    newTag: "1.0.0"
  - name: iff-web
    newName: ghcr.io/you/iff-web
    newTag: "1.0.0"
```

### Or load into k3s without a registry

On the k3s node:

```bash
docker save iff-api:local iff-web:local | sudo k3s ctr images import -
```

---

## 2. Create `site.yaml`

```bash
cp deploy/k3s/site.example.yaml deploy/k3s/site.yaml
```

| Section | What to set |
| --- | --- |
| Secret | Strong `POSTGRES_PASSWORD` and matching `DATABASE_URL`; `SESSION_SECRET` from `openssl rand -base64 32`; keep `COOKIE_SECURE: "true"` behind HTTPS |
| PersistentVolume | `hostPath.path` → flat MP3 folder on the k3s node |
| Ingress (api + web) | Same `rules[].host` on both; web `path` (e.g. `/apppath`) and API `path: <web>/api(/\|$)(.*)`. Upload/apply read the web path for the image build and readiness probe. Change `ingressClassName` if not `nginx` |

The API mounts the library at `/library` (`LIBRARY_PATH=/library`). The PVC binds to the PV via `volumeName: iff-library-pv`.

---

## 3. Apply the stack

```bash
export DEPLOY_HOST=you@your-server
npm run deploy:k3s:apply
```

Applies namespace + `site.yaml` + the stack over SSH (stamps `@BASE_PATH@` in `web.yaml` and `api.yaml` from the web Ingress path).

---

## 4. Database migrations

Nothing to run: the API pod has a `migrate` initContainer that applies pending migrations before the API starts, on every rollout. `deploy:k3s:apply` prints its log at the end; if the API pod is stuck in `Init`, check `kubectl -n iff-audio logs deploy/iff-api -c migrate`.

---

## 5. Create the first user

```bash
export DEPLOY_HOST=you@your-server
./deploy/k3s/create-user.sh you@example.com

# Reset an existing user's password
./deploy/k3s/create-user.sh you@example.com --reset
```

The script prompts for the password (or reads the first line of stdin) and pipes it into the pod, so it never appears in the pod spec, `ps` or shell history.

---

## 6. Sync the library

MP3s should already be in the host folder from step 2 (flat `*.mp3` only):

```bash
export DEPLOY_HOST=you@your-server
./deploy/k3s/sync-library.sh
```

After renaming a file on disk:

```bash
./deploy/k3s/rename-track.sh old-name.mp3 new-name.mp3
```

---

## 7. Apache

```apache
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"

ProxyPass        /apppath/ http://<k3s-ingress>/apppath/
ProxyPassReverse /apppath/ http://<k3s-ingress>/apppath/
```

---

## 8. Smoke test

```bash
curl -sS https://<domain>/apppath/api/health
# {"ok":true}
```

Open `https://<domain>/apppath/`, log in, browse the library, play a track, add a tag.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| JS/CSS 404 under `/assets` | Web image built without `/apppath/` base; or Ingress rewrote web paths |
| Health OK but UI API calls fail | Rebuild web with `VITE_API_URL=/apppath/api` |
| Login cookie missing | `COOKIE_SECURE`, `X-Forwarded-Proto`, Apache cookie forwarding |
| Empty library / play 404 | `hostPath` in `site.yaml`, PVC Bound, `LIBRARY_PATH=/library`, run `sync-library.sh`; API `replicas: 1` |
| PVC Pending | Apply `site.yaml` (PV) before the stack; `storageClassName` / `volumeName` must match |
| API path 404 | API Ingress rewrite not stripping `/apppath/api` |
| `CreateContainerError` / `no match for platform` | Images built for arm64 on Apple Silicon; rebuild with `--platform linux/amd64` (`npm run docker:build`) |

---

## 9. Redeploy

```bash
export DEPLOY_HOST=you@your-server

npm run deploy:k3s:upload
npm run deploy:k3s:apply
```

Schema changes are migrated automatically (step 4). After adding/removing MP3s on the host folder, re-run sync (step 6).

---

## 10. Database backups

`deploy/k3s/db.sh` creates and applies `pg_dump` backups. Backups are made manually (nothing runs on a schedule).

```bash
export DEPLOY_HOST=you@your-server

./deploy/k3s/db.sh backup [label]            # dump the server DB, stored on the server
./deploy/k3s/db.sh backup --download [label] # … and also copied to ./backups/
./deploy/k3s/db.sh list                      # server and local backups
./deploy/k3s/db.sh pull <name>               # copy a server backup to ./backups/
./deploy/k3s/db.sh restore <name>            # server backup → server DB
./deploy/k3s/db.sh restore backups/<file>    # local file → server DB
./deploy/k3s/db.sh mirror [--with-mp3s]      # fresh server backup → local DB
./deploy/k3s/db.sh mirror <name | file>      # given backup → local DB
```

- **Where:** server backups go to `/var/backups/iff-audio` on the k3s node (root-only; override with `SERVER_BACKUP_DIR`). Local copies go to `./backups/` (gitignored). Backups contain password hashes, so treat them as secrets.
- **Names:** `iff-<origin>-<YYYYmmdd-HHMMSS>[-label].dump`. Origin is `server` or `local`. Restoring a `local` backup (or one with another name) to the server needs a stronger confirmation, because it brings that DB's users and passwords along.
- **Sessions:** session rows are not backed up. After a restore, everyone logs in again.
- **Schema:** a backup from older code is fine, because migrations run after the restore. A backup from newer code than what is deployed (or checked out, for `mirror`) is refused.
- **Safety:** `restore` and `mirror` explain what will happen and ask you to type a confirmation phrase. Before replacing anything, they write a safety backup of the DB they replace (`…-pre-restore` on the server, `…-pre-mirror` in `./backups/`).

**`restore`** restores into a temporary database while the site keeps running. It then stops the API for a few seconds, swaps the databases, starts the API (which runs migrations) and runs `sync-library.sh`. If the restore step fails, the live DB is not changed. A local file is also copied to the server backup folder, as a record of what was applied.

**`mirror`** replaces your local Docker Compose DB, then runs `npm run migrate -w @iff/db` and `npm run sync-library -w api`. The local MP3 folder does not have to match the server: tracks are matched by filename. Server tracks without a local file show as missing but keep their comments, waveform and duration. Local-only MP3s are added as new tracks and disappear on the next mirror. `--with-mp3s` first copies MP3s that are missing locally from the server's library folder (`hostPath` in `site.yaml`), using `rsync` and `sudo` on the node. It never overwrites or deletes local files. Copy MP3s with their mtime preserved (`rsync -t`), otherwise sync treats them as changed and recomputes their waveforms.

Local development: see [README.md](./README.md).
