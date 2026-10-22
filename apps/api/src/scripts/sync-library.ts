import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { eq, inArray } from "drizzle-orm";
import { createDb, tracks } from "@iff/db";
import {
  libraryFilePath,
  listLibraryMp3s,
  requireLibraryPath,
} from "../library.js";
import { computePeaks, hasFfmpeg } from "../peaks.js";

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

/** Rows whose peaks + duration must be (re)computed after the upsert pass. */
const needPeaks: { id: string; filename: string }[] = [];

for (const file of onDisk) {
  const row = byFilename.get(file.filename);
  if (!row) {
    const [created] = await db
      .insert(tracks)
      .values({
        filename: file.filename,
        present: true,
        sizeBytes: file.sizeBytes,
        mtime: file.mtime,
        updatedAt: now,
      })
      .returning({ id: tracks.id });
    needPeaks.push({ id: created.id, filename: file.filename });
    inserted++;
    continue;
  }

  const sameSize = row.sizeBytes === file.sizeBytes;
  const sameMtime = row.mtime.getTime() === file.mtime.getTime();
  const contentChanged = !sameSize || !sameMtime;
  if (!row.present || contentChanged) {
    await db
      .update(tracks)
      .set({
        present: true,
        sizeBytes: file.sizeBytes,
        mtime: file.mtime,
        updatedAt: now,
        // Stale for the new file contents; recomputed below.
        ...(contentChanged ? { peaks: null, durationSeconds: null } : {}),
      })
      .where(eq(tracks.id, row.id));
    updated++;
  }
  if (contentChanged || row.peaks == null || row.durationSeconds == null) {
    needPeaks.push({ id: row.id, filename: file.filename });
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

let peaksComputed = 0;
let peaksFailed = 0;
let peaksSkipped = false;

if (needPeaks.length > 0) {
  if (!(await hasFfmpeg())) {
    peaksSkipped = true;
    console.warn(
      `ffmpeg not found on PATH — skipping peaks/duration for ${needPeaks.length} track(s)`,
    );
  } else {
    for (const [i, item] of needPeaks.entries()) {
      const label = `[${i + 1}/${needPeaks.length}] ${item.filename}`;
      try {
        const { peaks, durationSec } = await computePeaks(
          libraryFilePath(libraryPath, item.filename),
        );
        await db
          .update(tracks)
          .set({ peaks, durationSeconds: Math.round(durationSec) })
          .where(eq(tracks.id, item.id));
        peaksComputed++;
        console.log(`${label} ${durationSec.toFixed(1)}s`);
      } catch (e) {
        peaksFailed++;
        console.error(`${label} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

console.log(
  JSON.stringify(
    {
      libraryPath,
      onDisk: onDisk.length,
      inserted,
      updated,
      markedMissing,
      peaksPending: needPeaks.length,
      peaksComputed,
      peaksFailed,
      peaksSkipped,
    },
    null,
    2,
  ),
);
process.exit(0);
