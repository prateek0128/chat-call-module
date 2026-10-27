import { defineConfig } from "tsup";
import path from "node:path";

// The engine is shared with the React Native package (mobile/src/engine). It is bundled into
// dist/index.js through this alias, so consumers only install commskit-web.
const engine = path.resolve(__dirname, "../mobile/src/engine/index.ts");

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "es2020",
  dts: { resolve: true },
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom", "react/jsx-runtime"],
  esbuildOptions(options) {
    options.alias = { ...(options.alias || {}), "commskit/engine": engine };
  },
});
