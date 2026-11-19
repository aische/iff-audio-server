/**
 * Builds a fresh test world before the API starts: recreates the `iff_e2e`
 * database, runs migrations, generates short MP3s, syncs them with the real
 * sync script (peaks + durations) and creates the test users.
 *
 * Run by the API webServer command in playwright.config.ts.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  FILLER_COUNT,
  RELEASED_LABEL,
  TRACKS,
  USERS,
  apiEnv,
  e2eDatabaseUrl,
  fillerName,
  libraryDir,
  repoRoot,
} from "./env.ts";

const dbUrl = e2eDatabaseUrl();
const dbName = new URL(dbUrl).pathname.slice(1);
if (!/^iff_e2e\w*$/.test(dbName)) {
  throw new Error(`Refusing to recreate database "${dbName}" (not iff_e2e*)`);
}

async function recreateDatabase() {
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists "${dbName}" with (force)`);
    await admin.unsafe(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }
}

async function migrateDatabase() {
  const client = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: path.join(repoRoot, "packages/db/drizzle"),
    });
  } finally {
    await client.end();
  }
}

function sineTone(filename: string, frequency: number, seconds: number) {
  execFileSync(
    "ffmpeg",
    [
      "-loglevel", "error",
      "-f", "lavfi",
      "-i", `sine=frequency=${frequency}:duration=${seconds}`,
      "-ac", "1",
      "-b:a", "64k",
      path.join(libraryDir, filename),
    ],
    { stdio: "inherit" },
  );
}

/**
 * 40 s sine tones, one pitch per named track (long enough to outlast a
 * test), plus short filler tracks that make the list scroll.
 */
function generateLibrary() {
  fs.rmSync(libraryDir, { recursive: true, force: true });
  fs.mkdirSync(libraryDir, { recursive: true });
  Object.values(TRACKS).forEach((filename, i) => {
    sineTone(filename, 220 * (i + 1), 40);
  });
  for (let n = 1; n <= FILLER_COUNT; n++) {
    sineTone(fillerName(n), 300 + 10 * n, 2);
  }
}

function runApiScript(script: string, args: string[], input?: string) {
  execFileSync("npm", ["run", "-s", script, "-w", "api", "--", ...args], {
    cwd: repoRoot,
    env: apiEnv(),
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "ignore", "inherit"],
  });
}

async function markReleased() {
  const client = postgres(dbUrl, { max: 1 });
  try {
    await client`update tracks set released_on = ${RELEASED_LABEL}
      where filename = ${TRACKS.delta}`;
  } finally {
    await client.end();
  }
}

await recreateDatabase();
await migrateDatabase();
generateLibrary();
runApiScript("sync-library", []);
for (const u of Object.values(USERS)) {
  runApiScript("create-user", [u.email], `${u.password}\n`);
}
await markReleased();
console.log(`e2e: prepared ${dbName} with ${Object.keys(TRACKS).length + FILLER_COUNT} tracks`);
