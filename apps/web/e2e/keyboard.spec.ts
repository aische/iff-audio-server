/**
 * Library keys (better-ux.md §3), the keyboard acceptance check for parallel
 * work: j / k / c / space never change the playing track, only enter / p
 * (or the play button) do, and keys do nothing while typing in a field.
 */
import type { Page } from "@playwright/test";
import { FILLER_COUNT, TRACKS, fillerName } from "./env.ts";
import {
  blur,
  expect,
  expectPlaying,
  openLibrary,
  play,
  row,
  test,
  title,
  trackId,
  unique,
} from "./helpers.ts";

const { alpha, bravo, charlie } = TRACKS;

/** The given track is loaded but paused (not stopped, not replaced). */
async function expectPaused(page: Page, filename: string) {
  const id = await trackId(page, filename);
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll("audio")]
          .filter((a) => a.currentSrc)
          .map((a) => ({ src: a.currentSrc, paused: a.paused })),
      ),
    )
    .toEqual([
      { src: expect.stringContaining(`/tracks/${id}/`), paused: true },
    ]);
  await expect(page.locator(".transport-title")).toHaveText(title(filename));
}

async function expectFocused(page: Page, filename: string) {
  await expect(row(page, filename)).toHaveClass(/track-focused/);
  await expect(page.locator(".track-focused")).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test("j/k/c/space never change the playing track; p and enter do", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);
  await expectFocused(page, alpha);

  // delta is released and hidden, so the list reads alpha, bravo, charlie…
  await page.keyboard.press("j");
  await expectFocused(page, bravo);
  await page.keyboard.press("j");
  await expectFocused(page, charlie);
  await page.keyboard.press("k");
  await expectFocused(page, bravo);
  await expect(row(page, alpha)).toHaveClass(/track-playing/);
  await expectPlaying(page, alpha);

  // c opens bravo's comment field without typing a "c" into it; esc leaves
  // the field and keeps bravo focused.
  const input = row(page, bravo).getByLabel(`Comment for ${bravo}`);
  const before = await input.inputValue();
  await page.keyboard.press("c");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(before);
  await expectPlaying(page, alpha);
  await page.keyboard.press("Escape");
  await expect(input).not.toBeFocused();
  await expect(row(page, bravo)).toBeFocused();
  await expectFocused(page, bravo);
  await expectPlaying(page, alpha);

  // Space pauses and resumes alpha; bravo stays focused.
  await page.keyboard.press(" ");
  await expectPaused(page, alpha);
  await page.keyboard.press(" ");
  await expectPlaying(page, alpha);
  await expectFocused(page, bravo);

  // p plays the focused track.
  await page.keyboard.press("p");
  await expectPlaying(page, bravo);
  await expect(row(page, bravo)).toHaveClass(/track-playing/);
  await expect(row(page, alpha)).not.toHaveClass(/track-playing/);

  // p on the track already playing neither stops nor restarts it.
  await page.keyboard.press("p");
  await expectPlaying(page, bravo);

  // enter plays the focused track too.
  await page.keyboard.press("k");
  await expectFocused(page, alpha);
  await expectPlaying(page, bravo);
  await page.keyboard.press("Enter");
  await expectPlaying(page, alpha);
});

test("space after clicking a row's play button pauses, never stops", async ({
  page,
}) => {
  // The ▶ keeps DOM focus after the click, and is now a ■ (stop).
  await play(page, charlie);
  await expectPlaying(page, charlie);
  await expect(
    page.getByRole("button", { name: `Stop ${charlie}` }),
  ).toBeFocused();

  await page.keyboard.press(" ");
  await expectPaused(page, charlie);
  await page.keyboard.press(" ");
  await expectPlaying(page, charlie);
});

test("keys do nothing while typing in a field", async ({ page }) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);
  await row(page, bravo).locator(".trackTitle").click();
  await expectFocused(page, bravo);

  // Search box: every key is just text.
  const search = page.getByLabel("Search tracks");
  await search.click();
  await page.keyboard.type("jk pc");
  await page.keyboard.press("Enter");
  await expect(search).toHaveValue("jk pc");
  await expectPlaying(page, alpha);
  await search.fill("");
  await expectFocused(page, bravo);

  // Comment field: same.
  const input = row(page, bravo).getByLabel(`Comment for ${bravo}`);
  const note = unique("jk p c");
  await input.fill("");
  await page.keyboard.type(note);
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue(note);
  await expectFocused(page, bravo);
  await expectPlaying(page, alpha);
  await page.keyboard.press("Escape");
  await expect(row(page, bravo).locator(".save-hint")).toHaveText("✓");
  await expectPlaying(page, alpha);
});

test("keys leave a focused row that the query hides alone", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);
  await row(page, bravo).locator(".trackTitle").click();

  await page.getByLabel("Search tracks").fill("charlie");
  await expect(row(page, bravo)).toHaveCount(0);
  await blur(page);
  await page.keyboard.press("p");
  await page.keyboard.press("c");
  await expectPlaying(page, alpha);

  // j starts again from the top of what is shown.
  await page.keyboard.press("j");
  await expectFocused(page, charlie);
  await expectPlaying(page, alpha);
});

test("k with nothing focused goes to the last row and scrolls to it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const last = row(page, fillerName(FILLER_COUNT));
  await expect(last).not.toBeInViewport();

  await page.keyboard.press("k");
  await expect(last).toHaveClass(/track-focused/);
  await expect(last).toBeInViewport();

  await page.keyboard.press("j");
  await expect(last).toHaveClass(/track-focused/);

  // Back up the list, one row at a time, with the row kept on screen.
  for (let i = 0; i < 30; i++) await page.keyboard.press("k");
  const up = row(page, fillerName(FILLER_COUNT - 30));
  await expect(up).toHaveClass(/track-focused/);
  await expect(up).toBeInViewport();
});

test("the key map opens with ? (button or key) and closes with esc", async ({
  page,
}) => {
  const map = page.getByRole("region", { name: "Keyboard shortcuts" });
  const button = page.getByRole("button", { name: "Keyboard shortcuts" });
  await expect(map).toHaveCount(0);

  await button.click();
  await expect(map).toBeVisible();
  await expect(map).toContainText("play the focused track");
  await expect(map.locator("kbd", { hasText: "space" })).toBeVisible();
  await button.click();
  await expect(map).toHaveCount(0);

  await page.keyboard.press("?");
  await expect(map).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(map).toHaveCount(0);

  // Typing ? in a field is just text.
  const search = page.getByLabel("Search tracks");
  await search.fill("");
  await search.press("?");
  await expect(search).toHaveValue("?");
  await expect(map).toHaveCount(0);

  // Library keys only exist in pool mode, and so does the key map.
  await page.getByRole("button", { name: "Arrange", exact: true }).click();
  await expect(button).toHaveCount(0);
  await page.locator(".studio-brand").click();
  await page.keyboard.press("?");
  await expect(map).toHaveCount(0);
  await page.getByRole("button", { name: "Library", exact: true }).click();
});
