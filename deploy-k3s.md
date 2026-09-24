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

Applies namespace + `site.yaml` + the stack over SSH (stamps `@BASE_PATH@` in `web.yaml` from the web Ingress path).

---

## 4. Migrate the database

```bash
export DEPLOY_HOST=you@your-server
MIGRATE=1 npm run deploy:k3s:apply
```

---

## 5. Create the first user

```bash
export DEPLOY_HOST=you@your-server
./deploy/k3s/create-user.sh you@example.com 'your-password'
```

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
# MIGRATE=1 npm run deploy:k3s:apply
```

After schema changes, use `MIGRATE=1`. After adding/removing MP3s on the host folder, re-run sync (step 6).

Local development: see [README.md](./README.md).
