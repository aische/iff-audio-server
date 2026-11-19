/**
 * Activity ribbon (better-ux.md §7): other users' comments and tags show up
 * as a thin, dismissible line; clicking one shows its track without
 * touching playback; own and retracted activity never shows.
 */
import path from "node:path";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { TRACKS, authDir, fillerName } from "./env.ts";
import {
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

/** User B's API session (saved by login.setup.ts). */
async function asB(browser: Browser, baseURL: string | undefined) {
  const ctx = await browser.newContext({
    storageState: path.join(authDir, "b.json"),
    baseURL,
  });
  return ctx.request;
}

async function comment(req: APIRequestContext, id: string, body: string) {
  const res = await req.put(`/api/tracks/${id}/comments`, { data: { body } });
  expect(res.ok()).toBe(true);
}

async function tag(req: APIRequestContext, id: string, name: string) {
  const res = await req.post(`/api/tracks/${id}/tags`, { data: { name } });
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { tag: { id: string } }).tag.id;
}

/** Wait until this browser has a "seen" cursor (first fetch done). */
async function cursorReady(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Object.keys(localStorage).some((k) =>
          k.startsWith("iff-activity-seen:"),
        ),
      ),
    )
    .toBe(true);
}

/** Poll the change feed now instead of waiting for its timer. */
function nudge(page: Page) {
  return page.evaluate(() => window.dispatchEvent(new Event("focus")));
}

function ribbon(page: Page) {
  return page.getByRole("region", { name: "Band activity" });
}

test("others' activity shows; clicking shows the track; × marks it seen", async ({
  page,
  browser,
  baseURL,
}) => {
  await openLibrary(page);
  await cursorReady(page);
  await play(page, alpha);
  await expectPlaying(page, alpha);
  await expect(ribbon(page)).toHaveCount(0);

  const b = await asB(browser, baseURL);
  const charlieId = await trackId(page, charlie);
  const name = unique("heard");
  await comment(b, charlieId, unique("b note"));
  await tag(b, charlieId, name);

  await nudge(page);
  await expect(ribbon(page)).toContainText(`b commented on ${title(charlie)}`);
  await expect(ribbon(page)).toContainText(
    `b tagged ${title(charlie)} #${name}`,
  );
  await expectPlaying(page, alpha);

  // Hide charlie, then ask the ribbon for it: shown and focused, not played.
  await page.getByLabel("Search tracks").fill(title(alpha));
  await expect(row(page, charlie)).toHaveCount(0);
  await ribbon(page)
    .getByRole("button", { name: `b commented on ${title(charlie)}` })
    .click();
  await expect(page.getByLabel("Search tracks")).toHaveValue("");
  await expect(row(page, charlie)).toHaveClass(/track-focused/);
  await expect(row(page, charlie)).toBeInViewport();
  await expectPlaying(page, alpha);

  await page.getByRole("button", { name: "Dismiss activity" }).click();
  await expect(ribbon(page)).toHaveCount(0);
  await expectPlaying(page, alpha);

  // Seen stays seen after a reload.
  await page.reload();
  await expect(page.locator(".trackList")).toBeVisible();
  await nudge(page);
  await page.waitForTimeout(1000);
  await expect(ribbon(page)).toHaveCount(0);
});

test("own activity and undone tags never show", async ({
  page,
  browser,
  baseURL,
}) => {
  await openLibrary(page);
  await cursorReady(page);

  // A's own comment.
  const mine = unique("a note");
  await row(page, bravo).getByLabel(`Comment for ${bravo}`).fill(mine);
  await row(page, bravo).getByLabel(`Comment for ${bravo}`).blur();
  await expect(row(page, bravo).locator(".save-hint")).toHaveText("✓");

  // B tags and untags (retracted), then comments on a marker track.
  const b = await asB(browser, baseURL);
  const bravoId = await trackId(page, bravo);
  const undone = unique("oops");
  const tagId = await tag(b, bravoId, undone);
  const del = await b.delete(`/api/tracks/${bravoId}/tags/${tagId}`);
  expect(del.ok()).toBe(true);
  const marker = fillerName(7);
  await comment(b, await trackId(page, marker), unique("marker"));

  await nudge(page);
  await expect(ribbon(page)).toContainText(`b commented on ${title(marker)}`);
  await expect(ribbon(page)).not.toContainText(undone);
  await expect(ribbon(page)).not.toContainText(`commented on ${title(bravo)}`);
  await expect(ribbon(page).getByRole("button")).toHaveCount(2); // item + ×
});
