import type { SessionStore } from "@fastify/session";
import type * as Fastify from "fastify";
import { eq, lt } from "drizzle-orm";
import { sessions, type Db } from "@iff/db";

/** Postgres-backed @fastify/session store; survives restarts and expires rows. */
export function createSessionStore(
  db: Db,
  { fallbackTtlMs, pruneIntervalMs }: { fallbackTtlMs: number; pruneIntervalMs: number },
): SessionStore {
  const prune = () =>
    db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .catch((err) => console.error("session prune failed", err));
  setInterval(prune, pruneIntervalMs).unref();

  function expiresAt(session: Fastify.Session) {
    const expires = session.cookie?.expires;
    return expires instanceof Date
      ? expires
      : new Date(Date.now() + fallbackTtlMs);
  }

  return {
    set(sessionId, session, callback) {
      const data = JSON.parse(JSON.stringify(session));
      const exp = expiresAt(session);
      db.insert(sessions)
        .values({ id: sessionId, data, expiresAt: exp })
        .onConflictDoUpdate({
          target: sessions.id,
          set: { data, expiresAt: exp },
        })
        .then(() => callback(), callback);
    },
    get(sessionId, callback) {
      db.select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1)
        .then(([row]) => {
          if (!row || row.expiresAt.getTime() <= Date.now()) {
            return callback(null, null);
          }
          callback(null, row.data as Fastify.Session);
        }, callback);
    },
    destroy(sessionId, callback) {
      db.delete(sessions)
        .where(eq(sessions.id, sessionId))
        .then(() => callback(), callback);
    },
  };
}
