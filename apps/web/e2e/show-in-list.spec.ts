/**
 * "Show in list" (transport, when the playing track is hidden) must clear
 * only what hides the track, and must not change saved preferences.
 */
import { TRACKS } from "./env.ts";
import {
  addTag,
  expect,
  expectPlaying,
  openLibrary,
  play,
  readStorage,
  row,
  test,
  unique,
} from "./helpers.ts";

const { alpha, charlie, delta } = TRACKS;
const HIDE_RELEASED_KEY = "iff-hide-released";

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test("search hides A: clears the search, keeps hide-released on", async ({
  page,
}) => {
  await play(page, alpha);
  await page.getByLabel("Search tracks").fill("zzz");
  await expect(row(page, alpha)).toHaveCount(0);

  await page.locator(".transport-reveal").click();

  await expect(page.getByLabel("Search tracks")).toHaveValue("");
  await expect(row(page, alpha)).toBeVisible();
  // The released track stays hidden: hide-released had nothing to do with it.
  await expect(
    page.getByRole("button", { name: "released hidden" }),
  ).toBeVisible();
  await expect(row(page, delta)).toHaveCount(0);
  expect(await readStorage(page, HIDE_RELEASED_KEY)).not.toBe("0");
  await expectPlaying(page, alpha);
});

test("search hides A: keeps a tag filter that A matches", async ({ page }) => {
  const tag = unique("keep");
  await addTag(page, charlie, tag);
  await row(page, charlie)
    .locator(".tag-chip-name", { hasText: tag })
    .click();
  const clearTag = page.getByRole("button", { name: `clear ${tag}` });
  await expect(clearTag).toBeVisible();

  await play(page, charlie);
  await page.getByLabel("Search tracks").fill("zzz");
  await expect(row(page, charlie)).toHaveCount(0);

  await page.locator(".transport-reveal").click();

  await expect(page.getByLabel("Search tracks")).toHaveValue("");
  await expect(clearTag).toBeVisible();
  await expect(row(page, charlie)).toBeVisible();
  await expect(row(page, alpha)).toHaveCount(0);
  await expectPlaying(page, charlie);
});

test("released A: shows released tracks for now, keeps the saved preference", async ({
  page,
}) => {
  // Show released tracks, start the released one, then hide released again.
  await page.getByRole("button", { name: "released hidden" }).click();
  await play(page, delta);
  await expectPlaying(page, delta);
  await page.getByRole("button", { name: "released shown" }).click();
  await expect(row(page, delta)).toHaveCount(0);
  const saved = await readStorage(page, HIDE_RELEASED_KEY);
  expect(saved).toBe("1");

  await page.locator(".transport-reveal").click();

  await expect(row(page, delta)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "released shown" }),
  ).toBeVisible();
  expect(await readStorage(page, HIDE_RELEASED_KEY)).toBe(saved);
  await expectPlaying(page, delta);

  // The saved preference is what the next visit starts with.
  await page.reload();
  await expect(
    page.getByRole("button", { name: "released hidden" }),
  ).toBeVisible();
});
