/**
 * Row waveforms (better-ux.md §2): peaks load only for rows on screen, and
 * the playing row shows a moving playhead without the other rows following.
 */
import type { Page } from "@playwright/test";
import { FILLER_COUNT, TRACKS, fillerName } from "./env.ts";
import {
  expect,
  expectPlaying,
  openLibrary,
  play,
  row,
  test,
  trackId,
} from "./helpers.ts";

const { alpha, bravo } = TRACKS;

/** Track ids whose peaks the page has requested so far. */
function recordPeakRequests(page: Page) {
  const ids = new Set<string>();
  page.on("request", (req) => {
    const m = /\/tracks\/([^/]+)\/peaks/.exec(req.url());
    if (m) ids.add(m[1]);
  });
  return ids;
}

/** The playhead's position along the row waveform, in percent. */
async function playheadPercent(page: Page, filename: string) {
  const transform = await row(page, filename)
    .locator(".row-wave-playhead")
    .evaluate((el) => (el as HTMLElement).style.transform);
  return Number(/translateX\(([\d.]+)%\)/.exec(transform)?.[1] ?? NaN);
}

test("peaks are requested only for rows on screen", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const requested = recordPeakRequests(page);
  await openLibrary(page);

  const last = fillerName(FILLER_COUNT);
  const lastId = await trackId(page, last);
  await expect(row(page, alpha).locator(".row-wave-canvas")).toBeVisible();
  const rowCount = await page.locator(".track1").count();
  expect(rowCount).toBeGreaterThan(FILLER_COUNT);
  // Let any further (wrong) requests arrive before counting.
  await page.waitForTimeout(500);
  expect(requested.size).toBeGreaterThan(0);
  expect(requested.size).toBeLessThan(rowCount);
  expect(requested.has(lastId)).toBe(false);

  await row(page, last).scrollIntoViewIfNeeded();
  await expect.poll(() => requested.has(lastId)).toBe(true);
  await expect(row(page, last).locator(".row-wave-canvas")).toBeVisible();
});

test("the playing row shows a moving playhead", async ({ page }) => {
  await openLibrary(page);
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await expect(page.locator(".row-wave-playhead")).toHaveCount(1);
  await expect(row(page, alpha).locator(".row-wave-playhead")).toHaveCount(1);
  const first = await playheadPercent(page, alpha);
  await expect
    .poll(() => playheadPercent(page, alpha))
    .toBeGreaterThan(first + 1);

  // Clicking another row's waveform does not change what is playing.
  await row(page, bravo).locator(".row-wave").click();
  await expectPlaying(page, alpha);

  // Clicking the playing row's waveform seeks within it.
  const wave = row(page, alpha).locator(".row-wave");
  const box = (await wave.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
  await expect.poll(() => playheadPercent(page, alpha)).toBeGreaterThan(70);
  await expectPlaying(page, alpha);
});
