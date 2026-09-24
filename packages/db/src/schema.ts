import {
  pgTable,
  uuid,
  text,
  timestamp,
  bigint,
  boolean,
  integer,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const tracks = pgTable("tracks", {
  id: uuid("id").defaultRandom().primaryKey(),
  filename: text("filename").notNull().unique(),
  present: boolean("present").notNull().default(true),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  /** Whole seconds; null until backfilled / probed. */
  durationSeconds: integer("duration_seconds"),
  mtime: timestamp("mtime", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** One comment per (user, track). Tags are derived from #tokens in body. */
export const comments = pgTable(
  "comments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    trackId: uuid("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique("comments_user_track_unique").on(t.userId, t.trackId)],
);

/** Clip on the arrangement timeline (start / in-point / duration / lane). */
export type ArrangementClip = {
  instanceId: string;
  trackId: string;
  startSec: number;
  offsetSec: number;
  durationSec: number;
  lane: number;
};

/** Playlist-capable arrangement; clips JSON. */
export const arrangements = pgTable(
  "arrangements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    clips: jsonb("clips").$type<ArrangementClip[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [unique("arrangements_user_name_unique").on(t.userId, t.name)],
);
