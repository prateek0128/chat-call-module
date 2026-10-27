"""Tiny test harness: a demo server per feature mode, headless Chrome driven over the DevTools
Protocol (plain `websockets`, no Selenium/Playwright), and scripted WebSocket users."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib
from pathlib import Path
from typing import Any

import websockets

HERE = Path(__file__).resolve().parent
DEMO_SERVER_DIR = HERE.parent  # examples/backend/demo-server-python (demo_server.py lives here)
SHOTS = HERE / "screenshots"

CHROME_CANDIDATES = [
    os.environ.get("CHROME_PATH", ""),
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    shutil.which("google-chrome") or "",
    shutil.which("chromium") or "",
    shutil.which("chrome") or "",
]


def find_chrome() -> str | None:
    return next((c for c in CHROME_CANDIDATES if c and Path(c).is_file()), None)


def kill_tree(proc: subprocess.Popen) -> None:
    """Stop a process and its children. (On Windows the venv python.exe is a launcher whose child is the real
    interpreter; terminate() alone would leave that child - the actual server - running.)"""
    if proc.poll() is None and os.name == "nt":
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()


def free_port() -> int:
    """A free localhost port. Never 8000 (the developer's own demo server lives there)."""
    while True:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        if port != 8000:
            return port


def http_json(url: str, timeout: float = 5) -> Any:
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return json.loads(res.read())


def http_text(url: str, timeout: float = 5) -> tuple[int, str, str]:
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return res.status, res.headers.get("content-type", ""), res.read().decode("utf-8")


# ------------------------------------------------------------------ demo server


class DemoServer:
    """`uvicorn demo_server:app` (or, with DEMO_BACKEND=node, the Node demo server) on a free port with its own temp data dir."""

    def __init__(self, features: str) -> None:
        self.features = features
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        self.data = Path(tempfile.mkdtemp(prefix=f"comms-ui-{features.replace(',', '-')}-"))
        env = {**os.environ, "COMMS_FEATURES": features, "COMMS_DEMO_DATA": str(self.data), "PYTHONUNBUFFERED": "1"}
        self.log = open(self.data / "server.log", "wb")
        if os.environ.get("DEMO_BACKEND", "").lower() == "node":  # the Node port: examples/backend/demo-server-node
            node_dir = DEMO_SERVER_DIR.parent / "demo-server-node"
            cmd, cwd = ["node", "server.mjs", "--port", str(self.port)], node_dir
        else:
            cmd = [sys.executable, "-m", "uvicorn", "demo_server:app", "--host", "127.0.0.1", "--port", str(self.port), "--log-level", "warning"]
            cwd = DEMO_SERVER_DIR
        self.proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"demo server exited: {(self.data / 'server.log').read_text(errors='replace')}")
            try:
                info = http_json(self.base + "/dev/users", timeout=1)
                assert sorted(info["features"]) == sorted(features.split(","))
                return
            except (OSError, ValueError):
                time.sleep(0.2)
        raise RuntimeError("demo server did not start")

    def token(self, uid: str) -> str:
        return http_json(f"{self.base}/dev/token/{uid}")["token"]

    def stop(self) -> None:
        kill_tree(self.proc)
        self.log.close()
        shutil.rmtree(self.data, ignore_errors=True)


# ------------------------------------------------------------------ scripted websocket user


class WsUser:
    """A second (scripted) user speaking the protocol directly."""

    def __init__(self, server: DemoServer, uid: str) -> None:
        self.server, self.uid = server, uid
        self.frames: list[dict] = []
        self._cond = asyncio.Condition()

    async def __aenter__(self) -> "WsUser":
        token = await asyncio.to_thread(self.server.token, self.uid)
        self.ws = await websockets.connect(f"ws://127.0.0.1:{self.server.port}/ws/{token}", max_size=None)
        self._reader = asyncio.create_task(self._read())
        return self

    async def __aexit__(self, *exc: Any) -> None:
        self._reader.cancel()
        await self.ws.close()

    async def _read(self) -> None:
        async for raw in self.ws:
            async with self._cond:
                self.frames.append(json.loads(raw))
                self._cond.notify_all()

    async def send(self, type_: str, **payload: Any) -> None:
        await self.ws.send(json.dumps({"type": type_, **payload}))

    async def wait_for(self, type_: str, pred=lambda f: True, timeout: float = 10) -> dict:
        async def find() -> dict:
            async with self._cond:
                while True:
                    for f in self.frames:
                        if f.get("type") == type_ and pred(f):
                            self.frames.remove(f)
                            return f
                    await self._cond.wait()
        try:
            return await asyncio.wait_for(find(), timeout)
        except asyncio.TimeoutError:
            raise AssertionError(f"{self.uid}: no {type_} frame; got {[f.get('type') for f in self.frames]}") from None

    async def chat_id_with(self, other: str) -> int:
        await self.send("get_messages", candidate_user_id=other, limit=1, offset=0)
        await self.wait_for("res_messages", lambda f: f["info"]["user_id"] == other)
        # /chats/start is idempotent and returns the pair's chat id
        def start() -> int:
            req = urllib.request.Request(f"{self.server.base}/chats/start?candidate_id={other}", method="POST",
                                         headers={"Authorization": f"Bearer {self.server.token(self.uid)}"})
            with urllib.request.urlopen(req, timeout=5) as res:
                return json.loads(res.read())["chat_id"]
        return await asyncio.to_thread(start)


# ------------------------------------------------------------------ Chrome / CDP


class Chrome:
    def __init__(self, path: str) -> None:
        self.profile = Path(tempfile.mkdtemp(prefix="comms-ui-chrome-"))
        self.proc = subprocess.Popen(
            [
                path, "--headless=new", "--remote-debugging-port=0", f"--user-data-dir={self.profile}",
                "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-sync",
                "--disable-background-networking", "--disable-component-update", "--mute-audio",
                "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                "--autoplay-policy=no-user-gesture-required",
                "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
                "--disable-backgrounding-occluded-windows", "--window-size=1280,800", "about:blank",
            ],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        port_file = self.profile / "DevToolsActivePort"
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if port_file.exists():
                lines = port_file.read_text().split()
                if len(lines) >= 2:
                    self.ws_url = f"ws://127.0.0.1:{lines[0]}{lines[1]}"
                    return
            time.sleep(0.1)
        raise RuntimeError("Chrome did not start")

    def stop(self) -> None:
        kill_tree(self.proc)
        time.sleep(0.5)
        shutil.rmtree(self.profile, ignore_errors=True)


class CDP:
    """One browser-level DevTools connection; pages are flattened sessions on it."""

    def __init__(self, ws: Any) -> None:
        self.ws = ws
        self._id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self.events: list[dict] = []
        self._reader = asyncio.create_task(self._read())

    @classmethod
    async def connect(cls, url: str) -> "CDP":
        return cls(await websockets.connect(url, max_size=None))

    async def _read(self) -> None:
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg:
                fut = self._pending.pop(msg["id"], None)
                if fut and not fut.done():
                    fut.set_result(msg)
            else:
                self.events.append(msg)
                if len(self.events) > 2000:
                    del self.events[:1000]

    async def send(self, method: str, params: dict | None = None, session: str | None = None, timeout: float = 30) -> dict:
        self._id += 1
        msg: dict[str, Any] = {"id": self._id, "method": method, "params": params or {}}
        if session:
            msg["sessionId"] = session
        fut = asyncio.get_running_loop().create_future()
        self._pending[self._id] = fut
        await self.ws.send(json.dumps(msg))
        res = await asyncio.wait_for(fut, timeout)
        if "error" in res:
            raise RuntimeError(f"{method}: {res['error']}")
        return res.get("result", {})

    async def new_page(self, width: int = 1280, height: int = 800, *, mobile: bool | None = None, init_script: str | None = None,
                       media: dict[str, str] | None = None) -> "Page":
        ctx = (await self.send("Target.createBrowserContext", {"disposeOnDetach": True}))["browserContextId"]
        target = (await self.send("Target.createTarget", {"url": "about:blank", "browserContextId": ctx, "newWindow": True}))["targetId"]
        session = (await self.send("Target.attachToTarget", {"targetId": target, "flatten": True}))["sessionId"]
        page = Page(self, target, session, ctx)
        await page.call("Page.enable")
        await page.call("Runtime.enable")
        await page.call("Emulation.setFocusEmulationEnabled", enabled=True)
        await page.set_viewport(width, height, mobile=mobile)
        if media:
            await page.emulate_media(media)
        if init_script:
            await page.call("Page.addScriptToEvaluateOnNewDocument", source=init_script)
        return page

    async def close(self) -> None:
        self._reader.cancel()
        await self.ws.close()


class Page:
    def __init__(self, cdp: CDP, target: str, session: str, ctx: str) -> None:
        self.cdp, self.target, self.session, self.ctx = cdp, target, session, ctx
        self.width = self.height = 0

    async def call(self, method: str, **params: Any) -> dict:
        return await self.cdp.send(method, params, self.session)

    async def close(self) -> None:
        try:
            await self.cdp.send("Target.closeTarget", {"targetId": self.target})
            await self.cdp.send("Target.disposeBrowserContext", {"browserContextId": self.ctx})
        except Exception:
            pass

    async def set_viewport(self, width: int, height: int, *, mobile: bool | None = None) -> None:
        if mobile is None:
            mobile = width < 1024 or height < 500
        self.width, self.height = width, height
        await self.call("Emulation.setDeviceMetricsOverride", width=width, height=height, deviceScaleFactor=1, mobile=mobile)
        await self.call("Emulation.setTouchEmulationEnabled", enabled=mobile, maxTouchPoints=5 if mobile else 1)

    async def emulate_media(self, features: dict[str, str]) -> None:
        await self.call("Emulation.setEmulatedMedia", features=[{"name": k, "value": v} for k, v in features.items()])

    async def goto(self, url: str) -> None:
        await self.call("Page.navigate", url=url)
        await self.wait("document.readyState === 'complete' && !!window.DemoApp", timeout=15, what="page load")

    async def eval(self, expr: str, *, await_promise: bool = True) -> Any:
        res = await self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=await_promise, userGesture=True)
        if "exceptionDetails" in res:
            d = res["exceptionDetails"]
            raise RuntimeError(f"JS error in {expr[:120]!r}: {d.get('exception', {}).get('description') or d.get('text')}")
        return res.get("result", {}).get("value")

    async def wait(self, expr: str, timeout: float = 10, *, what: str | None = None) -> Any:
        deadline = time.monotonic() + timeout
        last = None
        while time.monotonic() < deadline:
            try:
                last = await self.eval(expr)
            except RuntimeError as e:
                last = str(e)
            else:
                if last or isinstance(last, dict):  # a DOM node comes back by value as {}
                    return last
            await asyncio.sleep(0.1)
        shot = await self.screenshot(f"failure-{int(time.time() * 1000)}")
        raise AssertionError(f"timed out waiting for {what or expr} (last={last!r}); screenshot: {shot}")

    async def screenshot(self, name: str) -> Path:
        SHOTS.mkdir(exist_ok=True)
        data = (await self.call("Page.captureScreenshot", format="png"))["data"]
        path = SHOTS / f"{name}.png"
        path.write_bytes(base64.b64decode(data))
        return path

    # -- input: real mouse/keyboard events, so hit-testing and focus behave like a user's ----
    async def rect(self, selector: str) -> dict:
        r = await self.eval(f"""(() => {{ const el = document.querySelector({json.dumps(selector)}); if (!el) return null;
            const r = el.getBoundingClientRect(); return {{x: r.left, y: r.top, w: r.width, h: r.height}}; }})()""")
        if not r:
            raise AssertionError(f"no element {selector}")
        return r

    async def click(self, selector: str) -> None:
        check = await self.eval(f"({HIT_TEST_JS})({json.dumps(selector)})")
        if not check["ok"]:
            await self.screenshot(f"failure-click-{int(time.time() * 1000)}")
            raise AssertionError(f"cannot click {selector}: {check}")
        x, y = check["cx"], check["cy"]
        for kind in ("mousePressed", "mouseReleased"):
            await self.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="left", clickCount=1)

    async def type(self, text: str) -> None:
        await self.call("Input.insertText", text=text)

    async def press(self, key: str, *, shift: bool = False) -> None:
        codes = {"Enter": 13, "Escape": 27, "Tab": 9, "ArrowDown": 40, "ArrowUp": 38, "Home": 36, "End": 35}
        base: dict[str, Any] = {"key": key, "code": key, "windowsVirtualKeyCode": codes.get(key, 0), "modifiers": 8 if shift else 0}
        down = {**base, "type": "keyDown"}
        if key == "Enter":
            down["text"] = "\r"
        await self.call("Input.dispatchKeyEvent", **down)
        await self.call("Input.dispatchKeyEvent", **base, type="keyUp")


# Visible, inside the viewport, and actually hit-testable at its centre (not covered or clipped).
HIT_TEST_JS = """(sel) => {
  const el = document.querySelector(sel);
  if (!el) return {ok: false, why: 'missing', sel};
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const inside = r.width > 0 && r.height > 0 && r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  const reachable = !!hit && (hit === el || el.contains(hit));
  return {ok: inside && reachable, inside, reachable, sel, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          vw, vh, cx, cy, hit: hit ? hit.outerHTML.slice(0, 90) : null};
}"""

# Every visible element must end inside the viewport unless an ancestor scroll/clip box hides the overflow.
OVERFLOW_JS = """(() => {
  const vw = window.innerWidth;
  const bad = [];
  if (document.documentElement.scrollWidth > vw || document.body.scrollWidth > vw)
    bad.push('document scrollWidth ' + document.documentElement.scrollWidth + ' > ' + vw);
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (!el.checkVisibility({visibilityProperty: true, opacityProperty: true})) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= vw + 1 && r.left >= -1) continue;
    let clip = Infinity, clipL = -Infinity;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible') { const ar = a.getBoundingClientRect(); clip = Math.min(clip, ar.right); clipL = Math.max(clipL, ar.left); }
    }
    if (Math.min(r.right, clip) > vw + 1 || Math.max(r.left, clipL) < -1)
      bad.push(el.tagName.toLowerCase() + '.' + el.className + ' [' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
  }
  return bad.slice(0, 10);
})()"""


# ------------------------------------------------------------------ fixtures data


def make_png(width: int = 480, height: int = 360) -> bytes:
    """A small indigo-to-teal gradient PNG (no Pillow needed)."""
    rows = []
    for y in range(height):
        row = bytearray([0])
        for x in range(width):
            t = (x / width + y / height) / 2
            r = int(79 + (20 - 79) * t)
            g = int(70 + (184 - 70) * t)
            b = int(229 + (166 - 229) * t)
            if (x - width * 0.7) ** 2 + (y - height * 0.3) ** 2 < (height * 0.12) ** 2:
                r, g, b = 253, 230, 138
            row += bytes((r, g, b))
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
