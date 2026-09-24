import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { eq, inArray } from "drizzle-orm";
import { createDb, tracks } from "@iff/db";
import { listLibraryMp3s, requireLibraryPath } from "../library.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
dotenv.config({ path: path.join(root, ".env") });

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

let libraryPath: string;
try {
  libraryPath = requireLibraryPath();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL);

const onDisk = await listLibraryMp3s(libraryPath);
const onDiskNames = new Set(onDisk.map((f) => f.filename));
const now = new Date();

let inserted = 0;
let updated = 0;

const existing = await db.select().from(tracks);
const byFilename = new Map(existing.map((t) => [t.filename, t]));

for (const file of onDisk) {
  const row = byFilename.get(file.filename);
  if (!row) {
    await db.insert(tracks).values({
      filename: file.filename,
      present: true,
      sizeBytes: file.sizeBytes,
      mtime: file.mtime,
      updatedAt: now,
    });
    inserted++;
    continue;
  }

  const sameSize = row.sizeBytes === file.sizeBytes;
  const sameMtime = row.mtime.getTime() === file.mtime.getTime();
  if (!row.present || !sameSize || !sameMtime) {
    await db
      .update(tracks)
      .set({
        present: true,
        sizeBytes: file.sizeBytes,
        mtime: file.mtime,
        updatedAt: now,
      })
      .where(eq(tracks.id, row.id));
    updated++;
  }
}

const missingIds = existing
  .filter((t) => !onDiskNames.has(t.filename) && t.present)
  .map((t) => t.id);

let markedMissing = 0;
if (missingIds.length > 0) {
  await db
    .update(tracks)
    .set({ present: false, updatedAt: now })
    .where(inArray(tracks.id, missingIds));
  markedMissing = missingIds.length;
}

console.log(
  JSON.stringify(
    {
      libraryPath,
      onDisk: onDisk.length,
      inserted,
      updated,
      markedMissing,
    },
    null,
    2,
  ),
);
process.exit(0);
