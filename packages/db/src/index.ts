import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

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
