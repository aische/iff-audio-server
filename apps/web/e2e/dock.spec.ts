/**
 * Now Playing dock (better-ux.md §1): shows and scrubs what is playing while
 * the list is searched, offers "comment" on it, and folds to one line in
 * arrange mode.
 */
import type { Page } from "@playwright/test";
import { TRACKS } from "./env.ts";
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

function audioTime(page: Page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll("audio")].find((a) => a.currentSrc)
        ?.currentTime ?? -1,
  );
}

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test("dock shows and scrubs the playing track while the list is searched", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  const dock = page.getByRole("region", { name: "Now playing" });
  await page.getByLabel("Search tracks").fill("zzz");
  await expect(row(page, alpha)).toHaveCount(0);
  await expect(dock.locator(".transport-title")).toHaveText(title(alpha));
  await expect(dock.locator(".transport-hidden-label")).toHaveText(
    "not in list",
  );
  await expect(dock.locator(".transport-wave-canvas")).toBeVisible();

  // Click three quarters along the dock waveform: 40 s track → about 30 s.
  const wave = dock.locator(".transport-wave");
  const box = (await wave.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  await expect.poll(() => audioTime(page)).toBeGreaterThan(25);
  await expect(dock.locator(".transport-time")).toContainText("0:");
  // The search is untouched, and the same track keeps playing.
  await expect(page.getByLabel("Search tracks")).toHaveValue("zzz");
  await expectPlaying(page, alpha);
});

test("comment on what's playing reveals and focuses that row", async ({
  page,
}) => {
  await play(page, bravo);
  await expectPlaying(page, bravo);
  await page.getByLabel("Search tracks").fill("zzz");
  await expect(row(page, bravo)).toHaveCount(0);

  await page
    .getByRole("region", { name: "Now playing" })
    .getByRole("button", { name: "comment" })
    .click();

  const input = row(page, bravo).getByLabel(`Comment for ${bravo}`);
  await expect(input).toBeFocused();
  await expect(page.getByLabel("Search tracks")).toHaveValue("");

  const note = unique("dock note");
  await input.fill(note);
  await blur(page);
  await expect(row(page, bravo).locator(".save-hint")).toHaveText("✓");
  await expectPlaying(page, bravo);
});

test("in arrange mode the dock is one compact line", async ({ page }) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect(page.locator(".transport-compact")).toBeVisible();
  await expect(page.getByRole("region", { name: "Now playing" })).toHaveCount(
    0,
  );
  await expect(page.locator(".transport-wave")).toHaveCount(0);
  await expect(page.locator(".transport-comment")).toHaveCount(0);
  await expectPlaying(page, alpha);

  await page.getByRole("button", { name: "Pool", exact: true }).click();
  await expect(page.getByRole("region", { name: "Now playing" })).toBeVisible();
  await expectPlaying(page, alpha);
});
