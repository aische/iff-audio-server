import { defineConfig, devices } from "@playwright/test";
import { API_PORT, WEB_PORT, WEB_URL, apiEnv } from "./e2e/env.ts";

/**
 * End-to-end tests against a real API + Vite dev server, on their own ports
 * and their own database (`iff_e2e`, recreated on every run by
 * e2e/prepare.ts). Postgres and ffmpeg must be available, as for dev.
 */
export default defineConfig({
  testDir: "./e2e",
  // One shared database and real audio: run tests one after another.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "../../tmp/e2e/results",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "login", testMatch: /login\.setup\.ts/ },
    {
      name: "chromium",
      dependencies: ["login"],
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--autoplay-policy=no-user-gesture-required"],
        },
      },
    },
  ],
  webServer: [
    {
      // Never reuse: the database must be freshly prepared for every run.
      command: "npx tsx e2e/prepare.ts && npx tsx ../api/src/index.ts",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      env: apiEnv() as Record<string, string>,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: WEB_URL,
      reuseExistingServer: false,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
