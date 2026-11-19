/**
 * Shared settings for the end-to-end tests: ports, the throwaway database,
 * the generated audio library and the test users.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export const API_PORT = 3100;
export const WEB_PORT = 5174;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

/** Generated MP3s and saved logins; inside the git-ignored tmp/. */
export const e2eDir = path.join(repoRoot, "tmp", "e2e");
export const libraryDir = path.join(e2eDir, "library");
export const authDir = path.join(e2eDir, "auth");

export const USERS = {
  a: { email: "a@e2e.test", password: "e2e-password-a" },
  b: { email: "b@e2e.test", password: "e2e-password-b" },
} as const;

/** Filenames the tests refer to. `delta` is marked released by prepare. */
export const TRACKS = {
  alpha: "alpha.mp3",
  bravo: "bravo.mp3",
  charlie: "charlie.mp3",
  delta: "delta.mp3",
} as const;

export const RELEASED_LABEL = "EP1";

/**
 * Short filler tracks so the list is longer than the screen (row waveforms
 * load only for rows on screen). Named to sort after the tracks above.
 */
export const FILLER_COUNT = 40;
export function fillerName(n: number) {
  return `filler-${String(n).padStart(2, "0")}.mp3`;
}

/**
 * Database URL for the tests: E2E_DATABASE_URL, or the dev DATABASE_URL from
 * the root .env with the database name replaced by `iff_e2e`. The dev data
 * is never touched.
 */
export function e2eDatabaseUrl(): string {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  const dev = readDotenv().DATABASE_URL;
  if (!dev) {
    throw new Error("Set E2E_DATABASE_URL, or DATABASE_URL in the root .env");
  }
  const url = new URL(dev);
  url.pathname = "/iff_e2e";
  return url.toString();
}

function readDotenv(): Record<string, string> {
  const file = path.join(repoRoot, ".env");
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Environment for the API server and scripts. Every value the root .env
 * would set is given explicitly, so dotenv (which never overrides) can't
 * point the tests at dev data.
 */
export function apiEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: e2eDatabaseUrl(),
    LIBRARY_PATH: libraryDir,
    SESSION_SECRET: "e2e-session-secret-e2e-session-secret",
    CORS_ORIGIN: WEB_URL,
    COOKIE_SECURE: "false",
    TRUST_PROXY: "false",
    COOKIE_PATH: "/",
    PORT: String(API_PORT),
  };
}
