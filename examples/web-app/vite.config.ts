import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The demo server (examples/backend/demo-server-python/demo_server.py). The dev/preview servers proxy the API and the
// WebSocket to it, so the browser talks to one origin and no CORS setup is needed.
const server = process.env.COMMS_SERVER || "http://localhost:8000";
const paths = ["/dev", "/chats", "/moderation", "/devices", "/media", "/call"];
const proxy = {
  ...Object.fromEntries(paths.map((p) => [p, { target: server, changeOrigin: true }])),
  "/ws": { target: server, ws: true, changeOrigin: true },
};

export default defineConfig({
  plugins: [react()],
  // commskit-web is linked from ../../web and imports react itself: make sure there is only one copy.
  resolve: { dedupe: ["react", "react-dom"] },
  server: { port: Number(process.env.PORT) || 5173, proxy },
  preview: { port: Number(process.env.PORT) || 4173, proxy },
});
