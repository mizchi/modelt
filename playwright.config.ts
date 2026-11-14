import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["browser.spec.ts", "scheduling-browser.spec.ts"],
  use: { browserName: "chromium" },
  reporter: "list",
});
