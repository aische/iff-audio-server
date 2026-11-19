/**
 * Focus ≠ playing (better-ux.md §3): clicking a row focuses it without
 * changing what is playing, and the focus outline and the playing accent can
 * sit on different rows. The inspector follows hover, then focus.
 */
import { TRACKS } from "./env.ts";
import {
  expect,
  expectPlaying,
  openLibrary,
  play,
  row,
  test,
} from "./helpers.ts";

const { alpha, bravo, charlie } = TRACKS;

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test("focus outline and playing accent sit on different rows", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await row(page, bravo).locator(".trackTitle").click();
  await expect(row(page, bravo)).toHaveClass(/track-focused/);
  await expect(row(page, bravo)).not.toHaveClass(/track-playing/);
  await expect(row(page, alpha)).toHaveClass(/track-playing/);
  await expect(row(page, alpha)).not.toHaveClass(/track-focused/);
  await expect(page.locator(".track-focused")).toHaveCount(1);
  await expectPlaying(page, alpha);

  // Clicking a control in another row (the checkbox) moves focus too, and
  // still leaves playback alone.
  await page.getByLabel(`Check ${charlie}`).check();
  await expect(row(page, charlie)).toHaveClass(/track-focused/);
  await expect(row(page, bravo)).not.toHaveClass(/track-focused/);
  await expectPlaying(page, alpha);

  // The playing row can be the focused one as well: both marks at once.
  await row(page, alpha).locator(".trackTitle").click();
  await expect(row(page, alpha)).toHaveClass(/track-focused/);
  await expect(row(page, alpha)).toHaveClass(/track-playing/);
  await expectPlaying(page, alpha);
});

test("inspector shows the hovered track, else the focused one", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);
  const inspector = page.getByRole("complementary", { name: "Track details" });

  await row(page, charlie).locator(".trackTitle").click();
  // Pointer off the list: the card stays, on the focused track.
  await page.locator(".studio-brand").hover();
  await expect(inspector.locator(".inspector-title")).toHaveText("charlie");

  await row(page, bravo).locator(".trackTitle").hover();
  await expect(inspector.locator(".inspector-title")).toHaveText("bravo");

  await page.locator(".studio-brand").hover();
  await expect(inspector.locator(".inspector-title")).toHaveText("charlie");
  await expectPlaying(page, alpha);
});

test("focus survives a search that hides the row", async ({ page }) => {
  await row(page, bravo).locator(".trackTitle").click();
  await expect(row(page, bravo)).toHaveClass(/track-focused/);

  await page.getByLabel("Search tracks").fill("charlie");
  await expect(row(page, bravo)).toHaveCount(0);
  await page.getByLabel("Search tracks").fill("");
  await expect(row(page, bravo)).toHaveClass(/track-focused/);
});

test("dock comment focuses the playing row", async ({ page }) => {
  await play(page, bravo);
  await expectPlaying(page, bravo);
  await row(page, charlie).locator(".trackTitle").click();

  await page
    .getByRole("region", { name: "Now playing" })
    .getByRole("button", { name: "comment" })
    .click();

  await expect(row(page, bravo)).toHaveClass(/track-focused/);
  await expect(row(page, charlie)).not.toHaveClass(/track-focused/);
  await expect(row(page, bravo).getByLabel(`Comment for ${bravo}`)).toBeFocused();
  await expectPlaying(page, bravo);
});
