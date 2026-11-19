import { and, eq, gt, lt, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { events, type EventKind } from "./schema.js";

export * from "./schema.js";

export function createDb(connectionString: string) {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** Signal "something changed" to polling clients (see `changeRev`). */
export async function bumpRev(db: Db) {
  await db.execute(sql`select nextval('change_rev')`);
}

/** Current change revision, as a string (it is a bigint; only compared). */
export async function readRev(db: Db): Promise<string> {
  // A fresh sequence reports last_value = 1 before any nextval, and the first
  // nextval also returns 1; is_called tells the two apart.
  const rows = await db.execute<{ rev: string | number }>(
    sql`select case when is_called then last_value else 0 end as rev from change_rev`,
  );
  return String(rows[0]?.rev ?? "0");
}

/** Events older than this are pruned whenever a new one is written. */
const EVENT_RETENTION = sql`now() - interval '90 days'`;
/** Repeated comment saves (autosave while typing) within this window merge. */
const COMMENT_MERGE_WINDOW = sql`now() - interval '30 minutes'`;

/**
 * Record band activity for the ribbon. A comment event replaces the same
 * user's recent comment event on that track, so autosave doesn't flood
 * the feed; the new row gets a new id, so readers see the edit as new.
 */
export async function recordEvent(
  db: Db,
  e: {
    kind: EventKind;
    actorId: string | null;
    trackId: string | null;
    detail?: string | null;
  },
) {
  if (e.kind === "comment" && e.actorId && e.trackId) {
    await db
      .delete(events)
      .where(
        and(
          eq(events.kind, "comment"),
          eq(events.actorId, e.actorId),
          eq(events.trackId, e.trackId),
          gt(events.createdAt, COMMENT_MERGE_WINDOW),
        ),
      );
  }
  await db.insert(events).values({
    kind: e.kind,
    actorId: e.actorId,
    trackId: e.trackId,
    detail: e.detail ?? null,
  });
  await db.delete(events).where(lt(events.createdAt, EVENT_RETENTION));
}

/**
 * Drop events that are no longer true (comment deleted, tag removed,
 * release label cleared), so nobody is told about them later.
 */
export async function retractEvents(
  db: Db,
  e: {
    kind: EventKind;
    trackId: string;
    /** Only this user's events; omit for anyone's. */
    actorId?: string;
    /** Only events with this detail (e.g. the tag name). */
    detail?: string;
  },
) {
  const conds: SQL[] = [eq(events.kind, e.kind), eq(events.trackId, e.trackId)];
  if (e.actorId) conds.push(eq(events.actorId, e.actorId));
  if (e.detail !== undefined) conds.push(eq(events.detail, e.detail));
  await db.delete(events).where(and(...conds));
}

