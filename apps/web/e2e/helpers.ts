import path from "node:path";
import { expect, test as base, type Page } from "@playwright/test";
import { authDir } from "./env.ts";

/** Tests run logged in as user A (see login.setup.ts). */
export const test = base.extend({
  storageState: path.join(authDir, "a.json"),
});
export { expect };

export function title(filename: string) {
  return filename.replace(/\.mp3$/i, "");
}

/** The library row for a file (identified by its download link). */
export function row(page: Page, filename: string) {
  return page
    .locator(".track1")
    .filter({ has: page.getByRole("link", { name: `Download ${filename}` }) });
}

/** Open the app and wait for the track list. */
export async function openLibrary(page: Page) {
  await page.goto("/");
  await expect(page.locator(".trackList")).toBeVisible();
}

/** Start a track with its row play button (the row must be visible). */
export async function play(page: Page, filename: string) {
  await page.getByRole("button", { name: `Play ${filename}` }).click();
}

let idCache: Map<string, string> | null = null;

export async function trackId(page: Page, filename: string): Promise<string> {
  if (!idCache) {
    const res = await page.request.get("/api/tracks");
    expect(res.ok()).toBe(true);
    const tracks = (await res.json()) as { id: string; filename: string }[];
    idCache = new Map(tracks.map((t) => [t.filename, t.id]));
  }
  const id = idCache.get(filename);
  if (!id) throw new Error(`No track ${filename}`);
  return id;
}

type AudioState = { srcs: string[]; time: number | null };

/** All <audio> elements that are currently playing, and the first one's time. */
function playingAudio(page: Page): Promise<AudioState> {
  return page.evaluate(() => {
    const playing = [...document.querySelectorAll("audio")].filter(
      (a) => !a.paused && !a.ended,
    );
    return {
      srcs: playing.map((a) => a.currentSrc || a.src),
      time: playing[0]?.currentTime ?? null,
    };
  });
}

/**
 * The given track is what is in the speakers: exactly one audio element
 * plays, it plays this track, and its time moves forward. The transport
 * names the track.
 */
export async function expectPlaying(page: Page, filename: string) {
  const id = await trackId(page, filename);
  await expect
    .poll(async () => (await playingAudio(page)).srcs, {
      message: `only ${filename} should be playing`,
    })
    .toEqual([expect.stringContaining(`/tracks/${id}/`)]);
  const t0 = (await playingAudio(page)).time ?? 0;
  await expect
    .poll(async () => (await playingAudio(page)).time ?? -1, {
      message: `${filename} should be advancing`,
    })
    .toBeGreaterThan(t0 + 0.25);
  await expect(page.locator(".transport-title")).toHaveText(title(filename));
}

/** Leave whatever input has focus, so blur-autosave fires. */
export async function blur(page: Page) {
  await page.locator(".studio-brand").click();
}

export function readStorage(page: Page, key: string) {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

/** Add a band tag to a track via its row (the + shows on row hover). */
export async function addTag(page: Page, filename: string, name: string) {
  const r = row(page, filename);
  await r.hover();
  await r.getByRole("button", { name: `Add tag to ${filename}` }).click();
  await r.getByRole("combobox", { name: `Add tag to ${filename}` }).fill(name);
  await page.keyboard.press("Enter");
  await expect(r.locator(".tag-chip-name", { hasText: name })).toBeVisible();
}
