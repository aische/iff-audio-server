import path from "node:path";
import { fileURLToPath } from "node:url";
import { access, readdir, stat } from "node:fs/promises";

/** Monorepo root (apps/api/src → ../../..) so relative LIBRARY_PATH is cwd-independent. */
const monorepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export function requireLibraryPath(): string {
  const raw = process.env.LIBRARY_PATH?.trim();
  if (!raw) {
    throw new Error("LIBRARY_PATH is required");
  }
  return path.isAbsolute(raw) ? raw : path.resolve(monorepoRoot, raw);
}

/** Basename only; rejects path separators and `..`. */
export function assertBasename(filename: string): string {
  const name = filename.trim();
  if (!name) {
    throw new Error("filename is required");
  }
  if (
    name !== path.basename(name) ||
    name.includes("..") ||
    name.includes("/") ||
    name.includes("\\")
  ) {
    throw new Error("filename must be a basename only");
  }
  return name;
}

export function libraryFilePath(libraryPath: string, filename: string): string {
  const name = assertBasename(filename);
  return path.join(libraryPath, name);
}

export function isMp3Filename(filename: string): boolean {
  return filename.endsWith(".mp3");
}

export type LibraryFile = {
  filename: string;
  sizeBytes: number;
  mtime: Date;
};

export async function listLibraryMp3s(
  libraryPath: string,
): Promise<LibraryFile[]> {
  await access(libraryPath);
  const entries = await readdir(libraryPath, { withFileTypes: true });
  const files: LibraryFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isMp3Filename(entry.name)) continue;
    const abs = path.join(libraryPath, entry.name);
    const info = await stat(abs);
    files.push({
      filename: entry.name,
      sizeBytes: info.size,
      mtime: info.mtime,
    });
  }

  return files;
}
