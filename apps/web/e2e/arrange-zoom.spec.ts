/**
 * The clip inspector's waveform zoom (px/s) is kept when another clip is
 * selected; it no longer resets to a per-track fit.
 */
import { TRACKS, fillerName } from "./env.ts";
import { expect, openLibrary, test, title, unique } from "./helpers.ts";

const { alpha } = TRACKS;
// 40 s and 2 s: a per-track fit would give them very different zooms.
const short = fillerName(1);

test("waveform zoom stays when selecting another clip", async ({ page }) => {
  await openLibrary(page);
  await page.getByLabel(`Check ${alpha}`).check();
  await page.getByLabel(`Check ${short}`).check();
  await page.getByRole("button", { name: "new arrangement" }).click();
  await page.getByLabel("New arrangement name").fill(unique("zoom"));
  await page.getByRole("button", { name: "create", exact: true }).click();

  const rowFor = (filename: string) =>
    page.locator(".arr-row").filter({ hasText: title(filename) });
  const zoom = page.locator(".arr-insp-group .arr-muted", { hasText: "px/s" });

  await rowFor(alpha).click();
  await page.getByRole("button", { name: "wave", exact: true }).click();
  await page.getByRole("button", { name: "fit", exact: true }).click();
  const fitted = await zoom.textContent();
  expect(fitted).toMatch(/px\/s$/);

  await rowFor(short).click();
  await expect(page.locator(".arr-inspector-title")).toContainText(
    title(short),
  );
  await expect(zoom).toHaveText(fitted!);

  // Zooming on this clip carries back to the first one, too.
  await page.getByTitle("Zoom out waveform").click();
  const zoomedOut = await zoom.textContent();
  expect(zoomedOut).not.toBe(fitted);
  await rowFor(alpha).click();
  await expect(page.locator(".arr-inspector-title")).toContainText(
    title(alpha),
  );
  await expect(zoom).toHaveText(zoomedOut!);
});
