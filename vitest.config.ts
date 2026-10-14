import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: { LINK_SECRET: process.env.LINK_SECRET ?? "test-secret-test-secret-test-secret" },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
