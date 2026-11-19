/**
 * Session resume (better-ux.md §8): while nothing plays, the dock offers the
 * last played track (focused, never auto-played) and the tracks still
 * waiting for the user's comment.
 */
import type { Page } from "@playwright/test";
import { TRACKS, fillerName } from "./env.ts";
import {
  blur,
  expect,
  expectPlaying,
  openLibrary,
  play,
  row,
  test,
  title,
  unique,
} from "./helpers.ts";

const { alpha, bravo } = TRACKS;

function playingCount(page: Page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll("audio")].filter((a) => !a.paused).length,
  );
}

function waitingButton(page: Page) {
  return page
    .locator(".transport-empty .resume-action")
    .filter({ hasText: "without your comment" });
}

async function waitingCount(page: Page) {
  const text = (await waitingButton(page).textContent()) ?? "";
  return Number(text.match(/^(\d+)/)?.[1] ?? NaN);
}

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test("after a reload the dock offers the last played track, focused, not playing", async ({
  page,
}) => {
  await play(page, bravo);
  await expectPlaying(page, bravo);

  await page.reload();
  await expect(page.locator(".trackList")).toBeVisible();
  const resume = page.locator(".transport-empty .resume-title");
  await expect(resume).toHaveText(title(bravo));
  await expect(row(page, bravo)).toHaveClass(/track-focused/);
  await page.waitForTimeout(300);
  expect(await playingCount(page)).toBe(0);

  await page.getByRole("button", { name: `Continue ${bravo}` }).click();
  await expectPlaying(page, bravo);
});

test("show scrolls to the last played row, revealing it if hidden", async ({
  page,
}) => {
  const far = fillerName(35);
  await row(page, far).scrollIntoViewIfNeeded();
  await play(page, far);
  await expectPlaying(page, far);
  await page.getByRole("button", { name: `Stop ${far}` }).click();
  await expect(page.locator(".transport-empty .resume-title")).toHaveText(
    title(far),
  );

  // Hide it with a search, scroll away, then ask for it.
  await page.getByLabel("Search tracks").fill(title(alpha));
  await expect(row(page, far)).toHaveCount(0);
  await page.locator(".transport-empty").getByRole("button", { name: "show" }).click();

  await expect(page.getByLabel("Search tracks")).toHaveValue("");
  await expect(row(page, far)).toBeInViewport();
  await expect(row(page, far)).toBeFocused();
  await expect(row(page, far)).toHaveClass(/track-focused/);
  expect(await playingCount(page)).toBe(0);
});

test("tracks without your comment: the count opens that list, a new comment keeps its row", async ({
  page,
}) => {
  await expect(waitingButton(page)).toBeVisible();
  const n = await waitingCount(page);
  expect(n).toBeGreaterThan(0);

  await waitingButton(page).click();
  await expect(page.locator(".filter-summary")).toHaveText(
    "filters: released hidden · no comment from me",
  );
  const rows = page.locator(".trackList .track1");
  await expect(rows).toHaveCount(n);

  // Comment on a filler (alpha must stay uncommented for other tests).
  const target = rows.filter({ hasText: "filler" }).first();
  const label = await target
    .getByRole("link", { name: /^Download / })
    .getAttribute("aria-label");
  const filename = label!.replace(/^Download /, "");
  await row(page, filename)
    .getByLabel(`Comment for ${filename}`)
    .fill(unique("heard it"));
  await blur(page);
  await expect(row(page, filename).locator(".save-hint")).toHaveText("✓");
  // Still listed: it does not vanish while (or right after) commenting.
  await expect(row(page, filename)).toBeVisible();
  await expect(rows).toHaveCount(n);

  // Choosing the list again drops it.
  await expect.poll(() => waitingCount(page)).toBe(n - 1);
  await waitingButton(page).click();
  await expect(row(page, filename)).toHaveCount(0);
  await expect(rows).toHaveCount(n - 1);
});
