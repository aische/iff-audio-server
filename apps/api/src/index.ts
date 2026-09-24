import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import session from "@fastify/session";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  arrangements,
  comments,
  createDb,
  tracks,
  users,
  type ArrangementClip,
} from "@iff/db";
import { libraryFilePath, requireLibraryPath } from "./library.js";

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

const db = createDb(process.env.DATABASE_URL);
const app = Fastify({ logger: true, trustProxy });

if (corsOrigin) {
  await app.register(cors, {
    origin: corsOrigin,
    credentials: true,
  });
}

await app.register(cookie);
await app.register(session, {
  secret: process.env.SESSION_SECRET,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure,
  },
});

declare module "fastify" {
  interface Session {
    userId?: string;
  }
}

function requireUser(request: { session: { userId?: string } }) {
  return request.session.userId ?? null;
}

app.get("/health", async () => ({ ok: true }));

app.post<{
  Body: { email?: string; password?: string };
}>("/auth/login", async (request, reply) => {
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

  request.session.userId = user.id;
  return { id: user.id, email: user.email };
});

app.post("/auth/logout", async (request, reply) => {
  await request.session.destroy();
  return reply.code(204).send();
});

app.get("/auth/me", async (request, reply) => {
  const userId = requireUser(request);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
}>("/auth/change-password", async (request, reply) => {
  const userId = requireUser(request);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
});

app.get("/tracks", async (request, reply) => {
  const userId = requireUser(request);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });

  const rows = await db
    .select({
      id: tracks.id,
      filename: tracks.filename,
      present: tracks.present,
      sizeBytes: tracks.sizeBytes,
      durationSeconds: tracks.durationSeconds,
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

  return rows.map((track) => ({
    ...track,
    comments: byTrack.get(track.id) ?? [],
  }));
});

app.get<{ Params: { id: string } }>(
  "/tracks/:id/download",
  async (request, reply) => {
    const userId = requireUser(request);
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

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

    reply.header("Content-Type", "audio/mpeg");
    reply.header("Content-Disposition", `inline; filename="${track.filename}"`);
    return reply.send(createReadStream(absPath));
  },
);

app.get<{ Params: { id: string } }>(
  "/tracks/:id/comments",
  async (request, reply) => {
    const userId = requireUser(request);
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
}>("/tracks/:id/comments", async (request, reply) => {
  const userId = requireUser(request);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
});

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
      if (typeof c.trackId !== "string" || !c.trackId) return null;
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
    if (typeof c.trackId !== "string" || !c.trackId) return null;
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
  const userId = requireUser(request);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });

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

app.post<{ Body: { name?: string } }>(
  "/arrangements",
  async (request, reply) => {
    const userId = requireUser(request);
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const name = request.body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "name required" });

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
      .values({ userId, name, clips: [] })
      .returning();

    const withOwner = await arrangementWithOwner(row.id);
    return reply.code(201).send(serializeArrangement(withOwner!));
  },
);

app.get<{ Params: { id: string } }>(
  "/arrangements/:id",
  async (request, reply) => {
    const userId = requireUser(request);
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

    const row = await arrangementWithOwner(request.params.id);
    if (!row) return reply.code(404).send({ error: "not found" });

    return serializeArrangement(row);
  },
);

app.post<{ Params: { id: string } }>(
  "/arrangements/:id/copy",
  async (request, reply) => {
    const userId = requireUser(request);
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
}>("/arrangements/:id", async (request, reply) => {
  const userId = requireUser(request);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
    const clips = parseClips(request.body.clips);
    if (!clips) return reply.code(400).send({ error: "invalid clips" });
    if (clips.length > 0) {
      const ids = [...new Set(clips.map((c) => c.trackId))];
      const found = await db
        .select({ id: tracks.id })
        .from(tracks)
        .where(inArray(tracks.id, ids));
      if (found.length !== ids.length) {
        return reply.code(400).send({ error: "one or more tracks not found" });
      }
    }
    patch.clips = clips;
  }

  if (patch.name === undefined && patch.clips === undefined) {
    return reply.code(400).send({ error: "name or clips required" });
  }

  await db.update(arrangements).set(patch).where(eq(arrangements.id, row.id));

  const updated = await arrangementWithOwner(row.id);
  return serializeArrangement(updated!);
});

app.delete<{ Params: { id: string } }>(
  "/arrangements/:id",
  async (request, reply) => {
    const userId = requireUser(request);
    if (!userId) return reply.code(401).send({ error: "unauthorized" });

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
