import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "commskit/engine": path.resolve(__dirname, "../mobile/src/engine/index.ts") } },
  test: { environment: "jsdom", globals: true, include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["test/setup.ts"] },
});
