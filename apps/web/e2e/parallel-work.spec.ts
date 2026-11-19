/**
 * Acceptance checks for parallel work (.notes/better-ux.md): what is playing
 * must not change because of search, filters, hover, editing or checking.
 */
import { TRACKS } from "./env.ts";
import {
  addTag,
  blur,
  expect,
  expectPlaying,
  openFilters,
  openLibrary,
  play,
  row,
  test,
  trackId,
  unique,
} from "./helpers.ts";

const { alpha, bravo, charlie } = TRACKS;

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test("searching keeps the playing track playing", async ({ page }) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await page.getByLabel("Search tracks").fill("bravo");
  await expect(row(page, alpha)).toHaveCount(0);
  await expect(row(page, bravo)).toBeVisible();

  await expectPlaying(page, alpha);
});

test("editing comment and tags on another track keeps A playing", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  const note = unique("parallel note");
  const tag = unique("groove");
  const b = row(page, bravo);
  await b.getByLabel(`Comment for ${bravo}`).fill(note);
  await blur(page);
  await expect(b.locator(".save-hint")).toHaveText("✓");

  await addTag(page, bravo, tag);

  await expectPlaying(page, alpha);

  // Both edits reached the server.
  const id = await trackId(page, bravo);
  const tracks = (await (await page.request.get("/api/tracks")).json()) as {
    id: string;
    comments: { body: string }[];
    tags: { tagId: string }[];
  }[];
  const saved = tracks.find((t) => t.id === id)!;
  expect(saved.comments.map((c) => c.body)).toContain(note);
  const tags = (await (await page.request.get("/api/tags")).json()) as {
    id: string;
    name: string;
  }[];
  const tagId = tags.find((t) => t.name === tag)?.id;
  expect(saved.tags.map((l) => l.tagId)).toContain(tagId);
});

test("filtering A out of the list keeps it playing and offers to show it", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  // alpha never gets a comment in these tests, so "commented" hides it.
  await openFilters(page);
  await page.getByRole("button", { name: "commented", exact: true }).click();
  await expect(row(page, alpha)).toHaveCount(0);
  await expect(page.locator(".transport-hidden-label")).toHaveText(
    "not in list",
  );
  await expectPlaying(page, alpha);

  await page.locator(".transport-reveal").click();
  await expect(row(page, alpha)).toBeVisible();
  await expect(page.locator(".transport-hidden")).toHaveCount(0);
  await expectPlaying(page, alpha);
});

test("hovering B moves the inspector, not the transport", async ({ page }) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await row(page, bravo).locator(".trackTitle").hover();
  await expect(
    page.getByRole("complementary", { name: "Track details" }),
  ).toContainText("bravo");

  await expectPlaying(page, alpha);
});

test("checking tracks and building an arrangement keeps A playing", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await page.getByLabel(`Check ${bravo}`).check();
  await page.getByLabel(`Check ${charlie}`).check();
  await expect(page.locator(".checked-meta")).toContainText("2 checked");
  await expectPlaying(page, alpha);

  await page.getByRole("button", { name: "new arrangement" }).click();
  await page.getByLabel("New arrangement name").fill(unique("parallel cut"));
  await page.getByRole("button", { name: "create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Arrange", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");

  await expectPlaying(page, alpha);
});
