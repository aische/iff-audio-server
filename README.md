# iff-audio-server

Monorepo for a simple internal audio file server. Built for band members to listen, tag, comment on, and group audio files for release planning and sharing release candidates.

MP3s live in a flat folder configured by `LIBRARY_PATH`. A sync CLI upserts track rows by filename; the DB never deletes missing files (marks them absent). Auth is cookie sessions; there is no public signup — users are created with a CLI script.

## Prerequisites

- Node.js 20+ and npm
- Docker (for local Postgres)

## Setup

1. Install dependencies from the repo root:

   ```bash
   npm install
   ```

2. Copy the env example and fill in values:

   ```bash
   cp .env.example .env
   ```

   | Variable         | Scope           | Purpose                                                                               |
   | ---------------- | --------------- | ------------------------------------------------------------------------------------- |
   | `VITE_BASE_PATH` | Web (build/dev) | Asset base path. Local: `/`. Behind a subpath (e.g. k3s `/apppath`): `/apppath/`      |
   | `VITE_API_URL`   | Web (build/dev) | API URL used by the browser. Local: `/api` (Vite proxy). Prod example: `/apppath/api` |
   | `DATABASE_URL`   | API             | Postgres connection string                                                            |
   | `SESSION_SECRET` | API             | Long random string used to sign session cookies                                       |
   | `LIBRARY_PATH`   | API / CLIs      | Absolute or relative path to the flat MP3 library folder                              |
   | `CORS_ORIGIN`    | API             | If set, enables CORS for that origin (local Vite). Leave unset for same-origin prod   |
   | `COOKIE_SECURE`  | API             | `true` behind HTTPS so session cookies are marked Secure                              |
   | `TRUST_PROXY`    | API             | Optional. Defaults on when `COOKIE_SECURE=true` (TLS terminated at Apache/Ingress)    |

   Local defaults:

   ```env
   VITE_BASE_PATH=/
   VITE_API_URL=/api
   DATABASE_URL=postgresql://iff:iff@localhost:5432/iff
   SESSION_SECRET=change-me-to-a-long-random-string
   LIBRARY_PATH=./data/library
   CORS_ORIGIN=http://localhost:5173
   COOKIE_SECURE=false
   ```

3. Start Postgres:

   ```bash
   docker compose -f deploy/docker-compose.yml up -d
   ```

   This starts Postgres 16 on `localhost:5432` with user/password/db `iff` / `iff` / `iff`. Data is persisted in `data/postgres/`.

4. Apply database migrations:

   ```bash
   npm run migrate -w @iff/db
   ```

5. Create the library folder and drop MP3s in (flat — no subdirectories):

   ```bash
   mkdir -p data/library
   # cp /path/to/*.mp3 data/library/
   ```

6. Sync the folder into the database:

   ```bash
   npm run sync-library -w api
   ```

## Run locally

From the repo root (starts API and web in parallel):

```bash
npm run dev
```

Or separately:

```bash
npm run dev -w api
npm run dev -w web
```

- **API** — http://localhost:3000 (`PORT` overrides the default)
- **Web** — http://localhost:5173 (Vite proxies `/api` → `http://localhost:3000`)

Open the web UI at http://localhost:5173 and sign in with a user you created (below).

Health check (API directly):

```bash
curl http://localhost:3000/health
```

## Admin tools

There is no registration or browser upload. Use these CLIs (require `DATABASE_URL`; sync/rename also require `LIBRARY_PATH`):

```bash
# Create a user
npm run create-user -w api -- you@example.com 'your-password'

# Upsert tracks from the library folder (never deletes DB rows)
npm run sync-library -w api

# After renaming a file on disk, point the DB row at the new basename
# (keeps comments/arrangements attached via tracks.id)
npm run rename-track -w api -- old-name.mp3 new-name.mp3

# Apply migrations
npm run migrate -w @iff/db
```

- Email is stored lowercased; password must be at least 8 characters
- Sync only considers `*.mp3` files in the top level of `LIBRARY_PATH`
- Filenames are case-sensitive (as on Linux/k3s)

## Database

Schema lives in `packages/db`. Comments are one row per `(user, track)` (upsert); `#tags` live inside comment bodies and are unified in the UI. There is no separate tags table. Arrangements are per-user documents with a JSON `clips` array (timeline position, source in-point, duration, lane).

```bash
npm run migrate -w @iff/db
npm run generate -w @iff/db
npm exec -w @iff/db -- drizzle-kit studio
```

## Deploy

k3s under a public subpath (images, Ingress, Apache, migrate, sync, first user): see [deploy-k3s.md](./deploy-k3s.md).

## Project layout

```
apps/api          Fastify API (auth, library stream, comments/arrangements)
apps/web          React + Vite frontend
packages/db       Drizzle schema, migrations, DB client
deploy/           Docker Compose + k3s manifests
data/             Local Postgres volume + library folder (gitignored)
```
