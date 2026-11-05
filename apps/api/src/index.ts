import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import Fastify, {
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  arrangements,
  bumpRev,
  comments,
  createDb,
  readRev,
  tags,
  trackTags,
  tracks,
  users,
  type ArrangementClip,
} from "@iff/db";
import { libraryFilePath, requireLibraryPath } from "./library.js";
import { createSessionStore } from "./sessionStore.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
dotenv.config({ path: path.join(root, ".env") });

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required");

const libraryPath = requireLibraryPath();

const corsOrigin = process.env.CORS_ORIGIN?.trim() || undefined;
const cookieSecure = process.env.COOKIE_SECURE === "true";
const trustProxy = process.env.TRUST_PROXY === "true" || cookieSecure;
// Public path of the API (e.g. /apppath/api) so the cookie isn't sent to co-hosted apps.
// Set per session on login, not as the plugin's cookie.path: the plugin skips requests
// whose URL doesn't start with that path, and the Ingress strips the prefix.
const cookiePath = process.env.COOKIE_PATH?.trim() || "/";

const db = createDb(process.env.DATABASE_URL);
const app = Fastify({ logger: true, trustProxy });

if (corsOrigin) {
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

await app.register(cookie);
await app.register(session, {
  secret: process.env.SESSION_SECRET,
  cookieName: "iff_sid",
  // Only persist sessions that hold data (i.e. after login), not every probe/bot hit.
  saveUninitialized: false,
  // Don't rewrite the session row on every request (each audio Range request,
  // each poll); the auth hook renews it once it is past half its lifetime.
  rolling: false,
  store: createSessionStore(db, {
    fallbackTtlMs: SESSION_TTL_MS,
    pruneIntervalMs: 60 * 60 * 1000,
  }),
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
    maxAge: SESSION_TTL_MS,
  },
});

// Only routes that run a bcrypt compare are limited (brute force + CPU cost).
await app.register(rateLimit, { global: false });

/**
 * preHandler limiting requests per key. Uses createRateLimit because
 * app.rateLimit() handlers only run once per request, so two can't be stacked.
 */
function limitBy(
  max: number,
  timeWindow: string,
  keyGenerator: (request: FastifyRequest) => string,
) {
  const limiter = app.createRateLimit({ max, timeWindow, keyGenerator });
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await limiter(request);
    if (!result.isAllowed && result.isExceeded) {
      return reply
        .code(429)
        .header("retry-after", result.ttlInSeconds)
        .send({ error: "too many attempts, try again later" });
    }
  };
}

const loginLimitByIp = limitBy(20, "1 minute", (request) => `ip:${request.ip}`);
const loginLimitByEmail = limitBy(10, "15 minutes", (request) => {
  const email = (request.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string"
    ? `email:${email.trim().toLowerCase()}`
    : `ip:${request.ip}`;
});
const changePasswordLimit = limitBy(
  10,
  "15 minutes",
  (request) => `user:${request.userId}`,
);

// Only for reply.sendFile (Range/ETag/Content-Length); routes stay behind auth.
await app.register(fastifyStatic, { root: libraryPath, serve: false });

/** Header-safe ASCII fallback plus RFC 5987 UTF-8 filename. */
function contentDisposition(
  filename: string,
  kind: "inline" | "attachment" = "inline",
) {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )}`;
}

declare module "fastify" {
  interface Session {
    userId?: string;
    /** Last renewal (ms); changing it is what makes the plugin save the session. */
    renewedAt?: number;
  }
  interface FastifyContextConfig {
    /** Reachable without a session. Every other route requires login. */
    public?: boolean;
  }
  interface FastifyRequest {
    /** Logged-in user's id; set by the auth hook on every non-public route. */
    userId: string;
  }
}

// Auth is deny-by-default: routes opt out with `config: { public: true }`.
// Runs after the session plugin's onRequest hook, before body parsing.
app.decorateRequest("userId", "");
app.addHook("onRequest", async (request, reply) => {
  // CORS preflights carry no cookies; @fastify/cors answers them.
  if (request.method === "OPTIONS") return;
  if (request.routeOptions.config.public) return;
  const userId = request.session.userId;
  if (!userId) return reply.code(401).send({ error: "unauthorized" });
  request.userId = userId;
  renewSessionIfAging(request);
});

/**
 * Slide the session forward once less than half its lifetime is left.
 * On restore the plugin recomputes `cookie.expires` as now + maxAge; the
 * stored expiry is in the untyped `originalExpires`. `touch()` alone doesn't
 * mark the session modified (its hash ignores the cookie), so a data field
 * changes too, which makes the plugin save the row and re-send the cookie.
 */
function renewSessionIfAging(request: FastifyRequest) {
  const { originalExpires } = request.session.cookie as {
    originalExpires?: Date;
  };
  if (!originalExpires) return;
  if (originalExpires.getTime() - Date.now() >= SESSION_TTL_MS / 2) return;
  request.session.touch();
  request.session.renewedAt = Date.now();
}

// Validation errors → 400 with the ajv message; 5xx details stay in the log.
app.setErrorHandler<FastifyError>((error, request, reply) => {
  if (error.validation) {
    return reply.code(400).send({ error: error.message });
  }
  const status = error.statusCode ?? 500;
  if (status >= 500) {
    request.log.error(error);
    return reply.code(500).send({ error: "internal error" });
  }
  return reply.code(status).send({ error: error.message });
});

// Live updates: every successful write bumps the change revision, which
// clients poll via GET /changes. Done here, before the response is sent, so a
// poll right after a write already sees it; and centrally, so new routes
// can't forget it. Auth routes change no shared data.
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
app.addHook("onSend", async (request, reply, payload) => {
  if (
    WRITE_METHODS.has(request.method) &&
    reply.statusCode < 400 &&
    !request.routeOptions.url?.startsWith("/auth/")
  ) {
    await bumpRev(db);
  }
  return payload;
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

/** Body object whose listed properties are optional but typed (handlers report missing ones). */
function bodyOf(properties: Record<string, object>) {
  return { type: "object", properties } as const;
}

const passwordField = { type: "string", maxLength: 1024 };
const arrangementName = { type: "string", maxLength: 200 };

app.get("/health", { config: { public: true } }, async () => ({ ok: true }));

/** Change revision; clients refetch their data when it differs. */
app.get("/changes", async () => ({ rev: await readRev(db) }));

app.post<{
  Body: { email?: string; password?: string };
}>(
  "/auth/login",
  {
    schema: {
      body: bodyOf({
        email: { type: "string", maxLength: 254 },
        password: passwordField,
      }),
    },
    config: { public: true },
    preHandler: [loginLimitByIp, loginLimitByEmail],
  },
  async (request, reply) => {
    const email = request.body?.email?.trim().toLowerCase();
    const password = request.body?.password;
    if (!email || !password) {
      return reply.code(400).send({ error: "email and password required" });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid credentials" });
    }

    // New session id on login (prevents session fixation).
    await request.session.regenerate();
    request.session.options({ path: cookiePath });
    request.session.userId = user.id;
    return { id: user.id, email: user.email };
  },
);

app.post("/auth/logout", { config: { public: true } }, async (request, reply) => {
  await request.session.destroy();
  return reply.code(204).send();
});

app.get("/auth/me", async (request, reply) => {
  const { userId } = request;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) return reply.code(401).send({ error: "unauthorized" });

  return { id: user.id, email: user.email };
});

app.post<{
  Body: { currentPassword?: string; newPassword?: string };
}>(
  "/auth/change-password",
  {
    schema: {
      body: bodyOf({
        currentPassword: passwordField,
        newPassword: passwordField,
      }),
    },
    preHandler: changePasswordLimit,
  },
  async (request, reply) => {
    const { userId } = request;

    const { currentPassword, newPassword } = request.body ?? {};
    if (!currentPassword || !newPassword) {
      return reply
        .code(400)
        .send({ error: "currentPassword and newPassword required" });
    }
    if (newPassword.length < 8) {
      return reply
        .code(400)
        .send({ error: "newPassword must be at least 8 characters" });
    }

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid current password" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
    return reply.code(204).send();
  },
);

app.get("/tracks", async (request, reply) => {
  const rows = await db
    .select({
      id: tracks.id,
      filename: tracks.filename,
      present: tracks.present,
      sizeBytes: tracks.sizeBytes,
      durationSeconds: tracks.durationSeconds,
      releasedOn: tracks.releasedOn,
      mtime: tracks.mtime,
      createdAt: tracks.createdAt,
      updatedAt: tracks.updatedAt,
    })
    .from(tracks)
    .orderBy(asc(tracks.filename));

  const commentRows = await db
    .select({
      id: comments.id,
      trackId: comments.trackId,
      body: comments.body,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      userId: comments.userId,
      userEmail: users.email,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .orderBy(asc(comments.createdAt));

  const byTrack = new Map<
    string,
    {
      id: string;
      body: string;
      createdAt: Date;
      updatedAt: Date;
      userId: string;
      userEmail: string;
    }[]
  >();
  for (const row of commentRows) {
    const { trackId, ...rest } = row;
    const list = byTrack.get(trackId) ?? [];
    list.push(rest);
    byTrack.set(trackId, list);
  }

  const tagRows = await db
    .select({
      trackId: trackTags.trackId,
      tagId: trackTags.tagId,
      addedAt: trackTags.addedAt,
      addedByEmail: users.email,
    })
    .from(trackTags)
    .leftJoin(users, eq(trackTags.addedBy, users.id))
    .orderBy(asc(trackTags.addedAt));

  const tagsByTrack = new Map<
    string,
    { tagId: string; addedAt: Date; addedByEmail: string | null }[]
  >();
  for (const { trackId, ...rest } of tagRows) {
    const list = tagsByTrack.get(trackId) ?? [];
    list.push(rest);
    tagsByTrack.set(trackId, list);
  }

  return rows.map((track) => ({
    ...track,
    comments: byTrack.get(track.id) ?? [],
    tags: tagsByTrack.get(track.id) ?? [],
  }));
});

/** Set or clear the release label. Empty / null clears it. */
app.patch<{
  Params: { id: string };
  Body: { releasedOn?: string | null };
}>(
  "/tracks/:id",
  {
    schema: {
      params: idParams,
      body: bodyOf({
        releasedOn: { type: ["string", "null"], maxLength: 100 },
      }),
    },
  },
  async (request, reply) => {
    const raw = request.body?.releasedOn;
    if (raw !== null && typeof raw !== "string") {
      return reply.code(400).send({ error: "releasedOn required" });
    }
    const releasedOn = raw?.trim() || null;

    const [row] = await db
      .update(tracks)
      .set({ releasedOn, updatedAt: new Date() })
      .where(eq(tracks.id, request.params.id))
      .returning({
        id: tracks.id,
        releasedOn: tracks.releasedOn,
        updatedAt: tracks.updatedAt,
      });
    if (!row) return reply.code(404).send({ error: "not found" });

    return row;
  },
);

app.get<{ Params: { id: string } }>(
  "/tracks/:id/peaks",
  { schema: { params: idParams } },
  async (request, reply) => {
    const [track] = await db
      .select({
        peaks: tracks.peaks,
        durationSeconds: tracks.durationSeconds,
      })
      .from(tracks)
      .where(eq(tracks.id, request.params.id))
      .limit(1);

    if (!track) return reply.code(404).send({ error: "not found" });
    if (!track.peaks || track.durationSeconds == null) {
      return reply.code(404).send({ error: "peaks not computed" });
    }

    return { peaks: track.peaks, durationSec: track.durationSeconds };
  },
);

/** Streams the MP3 for playback; `?download=1` makes the browser save it. */
app.get<{ Params: { id: string }; Querystring: { download?: "1" } }>(
  "/tracks/:id/download",
  {
    schema: {
      params: idParams,
      querystring: {
        type: "object",
        properties: { download: { type: "string", enum: ["1"] } },
      },
    },
  },
  async (request, reply) => {
    const [track] = await db
      .select()
      .from(tracks)
      .where(eq(tracks.id, request.params.id))
      .limit(1);

    if (!track || !track.present) {
      return reply.code(404).send({ error: "not found" });
    }

    let absPath: string;
    try {
      absPath = libraryFilePath(libraryPath, track.filename);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }

    try {
      await access(absPath);
    } catch {
      return reply.code(404).send({ error: "file missing" });
    }

    reply.header(
      "Content-Disposition",
      contentDisposition(
        track.filename,
        request.query.download === "1" ? "attachment" : "inline",
      ),
    );
    return reply.type("audio/mpeg").sendFile(path.basename(absPath));
  },
);

app.get<{ Params: { id: string } }>(
  "/tracks/:id/comments",
  { schema: { params: idParams } },
  async (request, reply) => {
    const [track] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.id, request.params.id))
      .limit(1);
    if (!track) return reply.code(404).send({ error: "not found" });

    const rows = await db
      .select({
        id: comments.id,
        body: comments.body,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        userId: comments.userId,
        userEmail: users.email,
      })
      .from(comments)
      .innerJoin(users, eq(comments.userId, users.id))
      .where(eq(comments.trackId, track.id))
      .orderBy(asc(comments.createdAt));

    return rows;
  },
);

/** Upsert comment for this track. Empty body deletes it. */
app.put<{
  Params: { id: string };
  Body: { body?: string };
}>(
  "/tracks/:id/comments",
  {
    schema: {
      params: idParams,
      body: bodyOf({ body: { type: "string", maxLength: 20000 } }),
    },
  },
  async (request, reply) => {
    const { userId } = request;

    if (typeof request.body?.body !== "string") {
      return reply.code(400).send({ error: "body required" });
    }
    const body = request.body.body.trim();

    const [track] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.id, request.params.id))
      .limit(1);
    if (!track) return reply.code(404).send({ error: "not found" });

    if (!body) {
      await db
        .delete(comments)
        .where(and(eq(comments.trackId, track.id), eq(comments.userId, userId)));
      return reply.code(204).send();
    }

    const now = new Date();
    const [row] = await db
      .insert(comments)
      .values({
        trackId: track.id,
        userId,
        body,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [comments.userId, comments.trackId],
        set: { body, updatedAt: now },
      })
      .returning();

    const [user] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    return {
      id: row.id,
      body: row.body,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      userId: row.userId,
      userEmail: user?.email ?? "",
    };
  },
);

// --- Shared tags ---

const TAG_NAME_RE = /^[A-Za-z0-9_:-]{1,64}$/;
const tagNameField = { type: "string", maxLength: 100 };
const tagCategoryField = { type: ["string", "null"], maxLength: 100 };

/** Strip a leading '#' and whitespace; null if not a valid tag name. */
function normalizeTagName(raw: string): string | null {
  const name = raw.trim().replace(/^#+/, "");
  return TAG_NAME_RE.test(name) ? name : null;
}

/** Trimmed category, null when empty. */
function normalizeCategory(raw: string | null): string | null {
  return raw?.trim().slice(0, 40) || null;
}

const tagColumns = {
  id: tags.id,
  name: tags.name,
  category: tags.category,
};

/** Existing tag by name: exact match first, else case-insensitive. */
async function findTagByName(name: string, excludeId?: string) {
  const rows = await db
    .select(tagColumns)
    .from(tags)
    .where(
      and(
        sql`lower(${tags.name}) = lower(${name})`,
        excludeId ? ne(tags.id, excludeId) : undefined,
      ),
    );
  return rows.find((r) => r.name === name) ?? rows[0] ?? null;
}

app.get("/tags", async (request, reply) => {
  return db.select(tagColumns).from(tags).orderBy(asc(tags.name));
});

/** Add a shared tag to a track by name; creates the tag if it is new. */
app.post<{ Params: { id: string }; Body: { name?: string } }>(
  "/tracks/:id/tags",
  {
    schema: { params: idParams, body: bodyOf({ name: tagNameField }) },
  },
  async (request, reply) => {
    const { userId } = request;

    const name = normalizeTagName(request.body?.name ?? "");
    if (!name) {
      return reply.code(400).send({
        error: "tag name: 1-64 letters, digits, _ : or -",
      });
    }

    const [track] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(eq(tracks.id, request.params.id))
      .limit(1);
    if (!track) return reply.code(404).send({ error: "not found" });

    let tag = await findTagByName(name);
    if (!tag) {
      await db
        .insert(tags)
        .values({ name, createdBy: userId })
        .onConflictDoNothing({ target: tags.name });
      tag = await findTagByName(name);
    }
    if (!tag) return reply.code(500).send({ error: "could not create tag" });

    await db
      .insert(trackTags)
      .values({ trackId: track.id, tagId: tag.id, addedBy: userId })
      .onConflictDoNothing();

    const [link] = await db
      .select({
        tagId: trackTags.tagId,
        addedAt: trackTags.addedAt,
        addedByEmail: users.email,
      })
      .from(trackTags)
      .leftJoin(users, eq(trackTags.addedBy, users.id))
      .where(and(eq(trackTags.trackId, track.id), eq(trackTags.tagId, tag.id)))
      .limit(1);

    return { tag, link };
  },
);

app.delete<{ Params: { id: string; tagId: string } }>(
  "/tracks/:id/tags/:tagId",
  {
    schema: {
      params: {
        type: "object",
        required: ["id", "tagId"],
        properties: {
          id: { type: "string", format: "uuid" },
          tagId: { type: "string", format: "uuid" },
        },
      },
    },
  },
  async (request, reply) => {
    await db
      .delete(trackTags)
      .where(
        and(
          eq(trackTags.trackId, request.params.id),
          eq(trackTags.tagId, request.params.tagId),
        ),
      );
    return reply.code(204).send();
  },
);

/**
 * Rename and/or recategorize a tag. Renaming onto another tag's name
 * (case-insensitive) merges this tag into it.
 */
app.patch<{
  Params: { id: string };
  Body: { name?: string; category?: string | null };
}>(
  "/tags/:id",
  {
    schema: {
      params: idParams,
      body: bodyOf({ name: tagNameField, category: tagCategoryField }),
    },
  },
  async (request, reply) => {
    const body = request.body ?? {};
    const [tag] = await db
      .select(tagColumns)
      .from(tags)
      .where(eq(tags.id, request.params.id))
      .limit(1);
    if (!tag) return reply.code(404).send({ error: "not found" });

    const patch: { name?: string; category?: string | null } = {};
    if (body.name !== undefined) {
      const name = normalizeTagName(body.name);
      if (!name) {
        return reply.code(400).send({
          error: "tag name: 1-64 letters, digits, _ : or -",
        });
      }
      patch.name = name;
    }
    if (body.category !== undefined) {
      patch.category = normalizeCategory(body.category);
    }
    if (patch.name === undefined && patch.category === undefined) {
      return reply.code(400).send({ error: "name or category required" });
    }

    const target =
      patch.name !== undefined
        ? await findTagByName(patch.name, tag.id)
        : null;

    if (target) {
      // Merge: move this tag's tracks onto the target, then drop this tag.
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          INSERT INTO ${trackTags} (track_id, tag_id, added_by, added_at)
          SELECT track_id, ${target.id}, added_by, added_at
          FROM ${trackTags} WHERE tag_id = ${tag.id}
          ON CONFLICT DO NOTHING`);
        await tx.delete(tags).where(eq(tags.id, tag.id));
        if (patch.category !== undefined) {
          await tx
            .update(tags)
            .set({ category: patch.category })
            .where(eq(tags.id, target.id));
        }
      });
      const [merged] = await db
        .select(tagColumns)
        .from(tags)
        .where(eq(tags.id, target.id))
        .limit(1);
      return { tag: merged, mergedFrom: tag.id };
    }

    const [updated] = await db
      .update(tags)
      .set(patch)
      .where(eq(tags.id, tag.id))
      .returning(tagColumns);
    return { tag: updated, mergedFrom: null };
  },
);

app.delete<{ Params: { id: string } }>(
  "/tags/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const deleted = await db
      .delete(tags)
      .where(eq(tags.id, request.params.id))
      .returning({ id: tags.id });
    if (deleted.length === 0) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.code(204).send();
  },
);

const MIN_CLIP_SEC = 0.5;

function clampGain(n: number) {
  return Math.min(2, Math.max(0, n));
}

function normalizeClipFields(c: {
  instanceId: string;
  trackId: string;
  inSec: number;
  outSec: number;
  pauseSec: number;
  gain: number;
}): ArrangementClip {
  const inSec = Math.max(0, c.inSec);
  const outSec = Math.max(inSec + MIN_CLIP_SEC, c.outSec);
  return {
    instanceId: c.instanceId,
    trackId: c.trackId,
    inSec,
    outSec,
    pauseSec: Math.max(0, c.pauseSec),
    gain: clampGain(c.gain),
  };
}

/**
 * Accept new sequence clips, or migrate legacy timeline clips
 * ({ startSec, offsetSec, durationSec, lane } → ordered in/out).
 */
function parseClips(raw: unknown): ArrangementClip[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];

  const first = raw[0];
  if (!first || typeof first !== "object") return null;
  const sample = first as Record<string, unknown>;
  const isLegacy =
    typeof sample.offsetSec === "number" &&
    typeof sample.durationSec === "number" &&
    typeof sample.inSec !== "number";

  if (isLegacy) {
    type Legacy = {
      instanceId: string;
      trackId: string;
      startSec: number;
      offsetSec: number;
      durationSec: number;
      lane: number;
    };
    const legacy: Legacy[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") return null;
      const c = item as Record<string, unknown>;
      if (typeof c.instanceId !== "string" || !c.instanceId) return null;
      if (typeof c.trackId !== "string" || !UUID_RE.test(c.trackId))
        return null;
      if (typeof c.startSec !== "number" || !Number.isFinite(c.startSec))
        return null;
      if (typeof c.offsetSec !== "number" || !Number.isFinite(c.offsetSec))
        return null;
      if (typeof c.durationSec !== "number" || !Number.isFinite(c.durationSec))
        return null;
      if (typeof c.lane !== "number" || !Number.isFinite(c.lane)) return null;
      legacy.push({
        instanceId: c.instanceId,
        trackId: c.trackId,
        startSec: c.startSec,
        offsetSec: c.offsetSec,
        durationSec: c.durationSec,
        lane: c.lane,
      });
    }
    legacy.sort(
      (a, b) => a.startSec - b.startSec || a.lane - b.lane,
    );
    return legacy.map((c) =>
      normalizeClipFields({
        instanceId: c.instanceId,
        trackId: c.trackId,
        inSec: Math.max(0, c.offsetSec),
        outSec: Math.max(0, c.offsetSec) + Math.max(MIN_CLIP_SEC, c.durationSec),
        pauseSec: 0,
        gain: 1,
      }),
    );
  }

  const out: ArrangementClip[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const c = item as Record<string, unknown>;
    if (typeof c.instanceId !== "string" || !c.instanceId) return null;
    if (typeof c.trackId !== "string" || !UUID_RE.test(c.trackId))
      return null;
    if (typeof c.inSec !== "number" || !Number.isFinite(c.inSec)) return null;
    if (typeof c.outSec !== "number" || !Number.isFinite(c.outSec)) return null;
    const pauseSec =
      typeof c.pauseSec === "number" && Number.isFinite(c.pauseSec)
        ? c.pauseSec
        : 0;
    const gain =
      typeof c.gain === "number" && Number.isFinite(c.gain) ? c.gain : 1;
    out.push(
      normalizeClipFields({
        instanceId: c.instanceId,
        trackId: c.trackId,
        inSec: c.inSec,
        outSec: c.outSec,
        pauseSec,
        gain,
      }),
    );
  }
  return out;
}

/** Parse request clips and check that every referenced track exists. */
async function parseClipsForTracks(
  raw: unknown,
): Promise<
  { ok: true; clips: ArrangementClip[] } | { ok: false; error: string }
> {
  const clips = parseClips(raw);
  if (!clips) return { ok: false, error: "invalid clips" };
  if (clips.length > 0) {
    const ids = [...new Set(clips.map((c) => c.trackId))];
    const found = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(inArray(tracks.id, ids));
    if (found.length !== ids.length) {
      return { ok: false, error: "one or more tracks not found" };
    }
  }
  return { ok: true, clips };
}

/** Ensure stored JSON (possibly legacy) is always returned in new shape. */
function normalizeStoredClips(clips: unknown): ArrangementClip[] {
  return parseClips(clips) ?? [];
}

function serializeArrangement(row: {
  id: string;
  name: string;
  clips: ArrangementClip[] | unknown;
  createdAt: Date;
  updatedAt: Date;
  userId: string;
  userEmail: string;
}) {
  return {
    id: row.id,
    name: row.name,
    clips: normalizeStoredClips(row.clips),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    userId: row.userId,
    userEmail: row.userEmail,
  };
}

async function arrangementWithOwner(id: string) {
  const [row] = await db
    .select({
      id: arrangements.id,
      name: arrangements.name,
      clips: arrangements.clips,
      createdAt: arrangements.createdAt,
      updatedAt: arrangements.updatedAt,
      userId: arrangements.userId,
      userEmail: users.email,
    })
    .from(arrangements)
    .innerJoin(users, eq(arrangements.userId, users.id))
    .where(eq(arrangements.id, id))
    .limit(1);
  return row ?? null;
}

/** Pick a name unique for this user, preferring `base (copy)` then numbered. */
async function uniqueCopyName(userId: string, base: string) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base} (copy)` : `${base} (copy ${n})`;
    const [existing] = await db
      .select({ id: arrangements.id })
      .from(arrangements)
      .where(and(eq(arrangements.userId, userId), eq(arrangements.name, name)))
      .limit(1);
    if (!existing) return name;
  }
  return `${base} (copy ${crypto.randomUUID().slice(0, 8)})`;
}

app.get("/arrangements", async (request, reply) => {
  const rows = await db
    .select({
      id: arrangements.id,
      name: arrangements.name,
      clips: arrangements.clips,
      createdAt: arrangements.createdAt,
      updatedAt: arrangements.updatedAt,
      userId: arrangements.userId,
      userEmail: users.email,
    })
    .from(arrangements)
    .innerJoin(users, eq(arrangements.userId, users.id))
    .orderBy(desc(arrangements.updatedAt));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    clipCount: normalizeStoredClips(r.clips).length,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    userId: r.userId,
    userEmail: r.userEmail,
  }));
});

app.post<{ Body: { name?: string; clips?: unknown } }>(
  "/arrangements",
  {
    schema: {
      body: bodyOf({
        name: arrangementName,
        clips: { type: "array", maxItems: 2000 },
      }),
    },
  },
  async (request, reply) => {
    const { userId } = request;

    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "name required" });

    let clips: ArrangementClip[] = [];
    if (request.body?.clips !== undefined) {
      const parsed = await parseClipsForTracks(request.body.clips);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      clips = parsed.clips;
    }

    const [existing] = await db
      .select({ id: arrangements.id })
      .from(arrangements)
      .where(and(eq(arrangements.userId, userId), eq(arrangements.name, name)))
      .limit(1);
    if (existing) {
      return reply.code(409).send({ error: "arrangement already exists" });
    }

    const [row] = await db
      .insert(arrangements)
      .values({ userId, name, clips })
      .returning();

    const withOwner = await arrangementWithOwner(row.id);
    return reply.code(201).send(serializeArrangement(withOwner!));
  },
);

app.get<{ Params: { id: string } }>(
  "/arrangements/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const row = await arrangementWithOwner(request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });

    return serializeArrangement(row);
  },
);

app.post<{ Params: { id: string } }>(
  "/arrangements/:id/copy",
  { schema: { params: idParams } },
  async (request, reply) => {
    const { userId } = request;

    const source = await arrangementWithOwner(request.params.id);
    if (!source) return reply.code(404).send({ error: "not found" });

    const name = await uniqueCopyName(userId, source.name);
    const clips: ArrangementClip[] = normalizeStoredClips(source.clips).map(
      (c) => ({
        ...c,
        instanceId: crypto.randomUUID(),
      }),
    );

    const [row] = await db
      .insert(arrangements)
      .values({ userId, name, clips })
      .returning();

    const withOwner = await arrangementWithOwner(row.id);
    return reply.code(201).send(serializeArrangement(withOwner!));
  },
);

app.put<{
  Params: { id: string };
  Body: { name?: string; clips?: unknown };
}>(
  "/arrangements/:id",
  {
    schema: {
      params: idParams,
      body: bodyOf({
        name: arrangementName,
        clips: { type: "array", maxItems: 2000 },
      }),
    },
  },
  async (request, reply) => {
    const { userId } = request;

    const [row] = await db
      .select()
      .from(arrangements)
      .where(
        and(
          eq(arrangements.id, request.params.id),
          eq(arrangements.userId, userId),
        ),
      )
      .limit(1);
    if (!row) return reply.code(404).send({ error: "not found" });

    const patch: {
      name?: string;
      clips?: ArrangementClip[];
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (typeof request.body?.name === "string") {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: "name required" });
      if (name !== row.name) {
        const [conflict] = await db
          .select({ id: arrangements.id })
          .from(arrangements)
          .where(
            and(eq(arrangements.userId, userId), eq(arrangements.name, name)),
          )
          .limit(1);
        if (conflict) {
          return reply.code(409).send({ error: "arrangement already exists" });
        }
      }
      patch.name = name;
    }

    if (request.body?.clips !== undefined) {
      const parsed = await parseClipsForTracks(request.body.clips);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      patch.clips = parsed.clips;
    }

    if (patch.name === undefined && patch.clips === undefined) {
      return reply.code(400).send({ error: "name or clips required" });
    }

    await db.update(arrangements).set(patch).where(eq(arrangements.id, row.id));

    const updated = await arrangementWithOwner(row.id);
    return serializeArrangement(updated!);
  },
);

app.delete<{ Params: { id: string } }>(
  "/arrangements/:id",
  { schema: { params: idParams } },
  async (request, reply) => {
    const { userId } = request;

    const deleted = await db
      .delete(arrangements)
      .where(
        and(
          eq(arrangements.id, request.params.id),
          eq(arrangements.userId, userId),
        ),
      )
      .returning({ id: arrangements.id });

    if (deleted.length === 0) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.code(204).send();
  },
);

const port = Number(process.env.PORT) || 3000;
await app.listen({ port, host: "0.0.0.0" });
