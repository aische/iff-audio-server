/**
 * Library and arrangement playback never sound together: starting one
 * stops the other (better-ux.md, invariant rule 6).
 */
import { TRACKS } from "./env.ts";
import {
  expect,
  expectPlaying,
  openLibrary,
  play,
  test,
  unique,
} from "./helpers.ts";

const { alpha, bravo, charlie } = TRACKS;

test("arrangement and library playback stop each other", async ({ page }) => {
  await openLibrary(page);
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await page.getByLabel(`Check ${bravo}`).check();
  await page.getByRole("button", { name: "new subset" }).click();
  await page.getByLabel("New subset name").fill(unique("exclusion cut"));
  await page.getByRole("button", { name: "create", exact: true }).click();
  const arrPlay = page.locator(".arr-play");
  await expect(arrPlay).toHaveText("▶ play");
  await expectPlaying(page, alpha);

  // Arrangement takes over: the library transport unloads.
  await arrPlay.click();
  await expect(arrPlay).toHaveText("■ stop");
  await expect(page.locator(".transport-placeholder")).toHaveText("no track");
  await expect
    .poll(() =>
      page.evaluate(
        () => [...document.querySelectorAll("audio")].filter((a) => !a.paused)
          .length,
      ),
    )
    .toBe(0);

  // Library takes over again: the arrangement stops.
  await play(page, charlie);
  await expect(arrPlay).toHaveText("▶ play");
  await expectPlaying(page, charlie);
});
