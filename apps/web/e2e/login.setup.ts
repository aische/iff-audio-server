import path from "node:path";
import { expect, test as setup } from "@playwright/test";
import { USERS, authDir } from "./env.ts";

// Log in once per user and save the session: login is rate-limited
// (10 per email per 15 minutes), so tests must not log in themselves.
for (const [key, user] of Object.entries(USERS)) {
  setup(`log in as user ${key}`, async ({ page }) => {
    await page.goto("/");
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.locator(".user-email")).toHaveText(user.email);
    await page.context().storageState({
      path: path.join(authDir, `${key}.json`),
    });
  });
}
