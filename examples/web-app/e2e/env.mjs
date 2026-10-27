// Starts the demo server (backend venv) and the built web app (vite preview) on free ports, for the E2E run.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(here, "..");
export const kitDir = path.resolve(appDir, "..", "..");
const backendDir = path.join(kitDir, "backend", "backend-python");
const demoServerDir = path.join(kitDir, "examples", "backend", "demo-server-python");
const isWin = process.platform === "win32";
const python = path.join(backendDir, ".venv", isWin ? "Scripts/python.exe" : "bin/python");

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

const waitFor = async (url, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}`);
};

const kill = (child) => {
  if (!child || child.exitCode !== null) return;
  if (isWin) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
};

export const startStack = async ({ features = "chat" } = {}) => {
  if (process.env.DEMO_BACKEND !== "node" && !existsSync(python)) throw new Error(`backend venv python not found: ${python}`);
  const dataDir = mkdtempSync(path.join(tmpdir(), "commskit-web-e2e-"));
  const serverPort = await freePort();
  const appPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const appUrl = `http://127.0.0.1:${appPort}`;
  let server = null;
  const logs = [];

  const startServer = async () => {
    const useNode = process.env.DEMO_BACKEND === "node"; // the Node port: examples/backend/demo-server-node
    const [cmd, args, cwd] = useNode
      ? [process.execPath, ["server.mjs", "--port", String(serverPort)], path.join(kitDir, "examples", "backend", "demo-server-node")]
      : [python, ["-m", "uvicorn", "demo_server:app", "--host", "127.0.0.1", "--port", String(serverPort)], demoServerDir];
    server = spawn(cmd, args, {
      cwd,
      env: { ...process.env, COMMS_DEMO_DATA: dataDir, COMMS_FEATURES: features, COMMS_CORS_ORIGINS: appUrl, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (d) => logs.push(String(d)));
    server.stderr.on("data", (d) => logs.push(String(d)));
    await waitFor(`${serverUrl}/dev/users`);
  };
  await startServer();

  const vite = spawn(process.execPath, [path.join(appDir, "node_modules", "vite", "bin", "vite.js"), "preview", "--host", "127.0.0.1", "--strictPort"], {
    cwd: appDir,
    env: { ...process.env, COMMS_SERVER: serverUrl, PORT: String(appPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stderr.on("data", (d) => logs.push(String(d)));
  await waitFor(`${appUrl}/`);

  return {
    serverUrl,
    appUrl,
    dataDir,
    logs,
    stopServer: () => kill(server),
    startServer,
    stop: () => {
      kill(server);
      kill(vite);
    },
  };
};
