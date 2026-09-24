import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import dotenv from "dotenv";
import { eq } from "drizzle-orm";
import { createDb, tracks } from "@iff/db";
import {
  assertBasename,
  isMp3Filename,
  libraryFilePath,
  requireLibraryPath,
} from "../library.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
dotenv.config({ path: path.join(root, ".env") });

const oldRaw = process.argv[2];
const newRaw = process.argv[3];

if (!oldRaw || !newRaw) {
  console.error(
    "Usage: npm run rename-track -w api -- old-name.mp3 new-name.mp3",
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

let libraryPath: string;
let oldName: string;
let newName: string;
try {
  libraryPath = requireLibraryPath();
  oldName = assertBasename(oldRaw);
  newName = assertBasename(newRaw);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}

if (!isMp3Filename(newName)) {
  console.error("new filename must end with .mp3");
  process.exit(1);
}

if (oldName === newName) {
  console.error("old and new filenames are the same");
  process.exit(1);
}

const db = createDb(process.env.DATABASE_URL);

const [row] = await db
  .select()
  .from(tracks)
  .where(eq(tracks.filename, oldName))
  .limit(1);

if (!row) {
  console.error("No track with filename:", oldName);
  process.exit(1);
}

const [conflict] = await db
  .select()
  .from(tracks)
  .where(eq(tracks.filename, newName))
  .limit(1);

if (conflict) {
  console.error("Filename already in use:", newName);
  process.exit(1);
}

const oldPath = libraryFilePath(libraryPath, oldName);
const newPath = libraryFilePath(libraryPath, newName);

let oldOnDisk = false;
let newOnDisk = false;
try {
  await access(oldPath);
  oldOnDisk = true;
} catch {
  // absent
}
try {
  await access(newPath);
  newOnDisk = true;
} catch {
  // absent
}

if (oldOnDisk) {
  console.warn(
    "Warning: old file still on disk — rename the file on disk separately if needed:",
    oldPath,
  );
}
if (!newOnDisk) {
  console.warn(
    "Warning: new file not found on disk — place it at:",
    newPath,
  );
}

const [updated] = await db
  .update(tracks)
  .set({
    filename: newName,
    present: newOnDisk,
    updatedAt: new Date(),
  })
  .where(eq(tracks.id, row.id))
  .returning({
    id: tracks.id,
    filename: tracks.filename,
    present: tracks.present,
  });

console.log("Renamed track:", updated);
process.exit(0);
