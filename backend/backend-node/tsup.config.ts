import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "src/core/index.ts",
    chat: "src/chat/index.ts",
    call: "src/call/index.ts",
    moderation: "src/moderation/index.ts",
    integration: "src/integration/index.ts",
    push: "src/push/index.ts",
    redis: "src/redis/index.ts",
    s3: "src/s3/index.ts",
    fastify: "src/fastify/index.ts",
    express: "src/express/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  splitting: true,
  target: "node20",
  sourcemap: true,
  external: ["fastify", "express", "better-sqlite3", "pg", "ioredis", "sharp", "@aws-sdk/client-s3", "@aws-sdk/s3-request-presigner"],
});
