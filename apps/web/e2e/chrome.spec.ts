/**
 * Collapsed chrome (better-ux.md §4): filters and tag editing sit behind
 * disclosures; while the filters are closed, a one-line summary names the
 * active ones, so a hidden track always has a visible reason.
 */
import { TRACKS } from "./env.ts";
import {
  addTag,
  expect,
  expectPlaying,
  openLibrary,
  play,
  readStorage,
  row,
  test,
  unique,
} from "./helpers.ts";

const { alpha, bravo, delta } = TRACKS;

test.beforeEach(async ({ page }) => {
  await openLibrary(page);
});

test("filters start closed, with a summary of the active ones", async ({
  page,
}) => {
  const filterButton = page.getByRole("button", { name: "filter", exact: true });
  await expect(filterButton).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("group", { name: "Filters" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "commented", exact: true }),
  ).toHaveCount(0);
  // Hide-released is on by default: the summary says so.
  const summary = page.locator(".filter-summary");
  await expect(summary).toHaveText("filters: released hidden");
  await expect(row(page, delta)).toHaveCount(0);

  // The search scope only shows while there is a search.
  await expect(page.locator(".search-scope")).toHaveCount(0);
  await page.getByLabel("Search tracks").fill("alpha");
  await expect(page.locator(".search-scope")).toBeVisible();
  await page.getByLabel("Search tracks").fill("");

  // Opening the panel replaces the summary with the controls.
  await summary.click();
  await expect(filterButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".filter-summary")).toHaveCount(0);
  await page.getByRole("button", { name: "commented", exact: true }).click();

  // The open state is remembered; the filter itself is not.
  expect(await readStorage(page, "iff-filters-open")).toBe("1");
  await page.reload();
  await expect(page.getByRole("group", { name: "Filters" })).toBeVisible();
  await filterButton.click();
  await expect(page.locator(".filter-summary")).toHaveText(
    "filters: released hidden",
  );
});

test("summary names filter and tag; the tag clears without opening", async ({
  page,
}) => {
  const tag = unique("sum");
  await addTag(page, bravo, tag);
  await row(page, bravo).locator(".tag-chip-name", { hasText: tag }).click();
  await expect(page.locator(".filter-summary")).toHaveText(
    `filters: released hidden · #${tag}`,
  );
  await expect(row(page, alpha)).toHaveCount(0);

  await page.getByRole("button", { name: `clear ${tag}` }).click();
  await expect(page.locator(".filter-summary")).toHaveText(
    "filters: released hidden",
  );
  await expect(row(page, alpha)).toBeVisible();
});

test("edit holds tag removal and the tag manager", async ({ page }) => {
  const edit = page.getByRole("button", { name: "edit", exact: true });
  await expect(
    page.getByRole("button", { name: "edit tags", exact: true }),
  ).toHaveCount(0);

  await edit.click();
  await page.getByRole("button", { name: "edit tags", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "edit tags: on" }),
  ).toBeVisible();
  // Closed again, the edit button still says tag removal is on.
  await page.getByRole("button", { name: "edit: removing tags" }).click();
  await expect(page.getByRole("group", { name: "Edit" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "edit: removing tags" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "edit: removing tags" }).click();
  await page.getByRole("button", { name: "manage tags" }).click();
  await expect(page.locator(".tag-manager-head")).toBeVisible();
});

test("opening and closing the disclosures leaves playback alone", async ({
  page,
}) => {
  await play(page, alpha);
  await expectPlaying(page, alpha);

  await page.getByRole("button", { name: "filter", exact: true }).click();
  await page.getByRole("button", { name: "edit", exact: true }).click();
  await page.getByRole("button", { name: "filter", exact: true }).click();
  await page.getByRole("button", { name: "edit", exact: true }).click();

  await expectPlaying(page, alpha);
});
