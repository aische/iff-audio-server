/** Library transport: pause/resume, scrub and stop act on the loaded track. */
import type { Page } from "@playwright/test";
import { TRACKS } from "./env.ts";
import {
  expect,
  expectPlaying,
  openLibrary,
  play,
  test,
  title,
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

test("pause and resume keep the same track", async ({ page }) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await page.getByRole("button", { name: "Pause" }).click();
  const resume = page.getByRole("button", { name: "Play", exact: true });
  await expect(resume).toBeVisible();
  await expect(page.locator(".transport-title")).toHaveText(title(alpha));
  const paused = await audioTime(page);
  await page.waitForTimeout(500);
  expect(await audioTime(page)).toBe(paused);

  await resume.click();
  await expectPlaying(page, alpha);
  expect(await audioTime(page)).toBeGreaterThanOrEqual(paused);
});

test("scrubbing moves the position and the clock", async ({ page }) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await page.getByRole("slider", { name: "Scrub" }).fill("30");
  await expect.poll(() => audioTime(page)).toBeGreaterThanOrEqual(30);
  await expect(page.locator(".transport-time")).toContainText("0:3");
  await expectPlaying(page, alpha);
});

test("switching tracks and stopping from the row", async ({ page }) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await play(page, bravo);
  await expectPlaying(page, bravo);
  await expect(
    page.getByRole("button", { name: `Play ${alpha}` }),
  ).toBeVisible();

  await page.getByRole("button", { name: `Stop ${bravo}` }).click();
  await expect(page.locator(".transport-placeholder")).toHaveText("no track");
  await expect
    .poll(() =>
      page.evaluate(
        () => [...document.querySelectorAll("audio")].filter((a) => !a.paused)
          .length,
      ),
    )
    .toBe(0);
});
