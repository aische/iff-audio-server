import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function normalizeBase(base: string | undefined) {
  if (!base || base === "/") return "/";
  return base.endsWith("/") ? base : `${base}/`;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, "");
  return {
    base: normalizeBase(env.VITE_BASE_PATH),
    plugins: [react()],
    envDir: root,
    server: {
      proxy: {
        "/api": {
          // Overridden by the e2e tests, which run their own API.
          target: process.env.API_PROXY_TARGET || "http://localhost:3000",
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ""),
        },
      },
    },
  };
});
