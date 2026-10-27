"""Fixtures for the browser-demo UI tests.

Run from examples/backend/demo-server-python/:  ..\..\..\backend\backend-python\.venv\Scripts\python -m pytest -q ui_tests
(or ../../../backend/backend-python/.venv/bin/python on Linux/macOS)
Each feature mode gets its own demo server on a free port (never 8000) with a temp COMMS_DEMO_DATA,
so examples/backend/demo-server-python/.demo_data is never touched. Tests that need Chrome are skipped when it isn't installed.
"""

from __future__ import annotations

import asyncio
import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from _harness import CDP, Chrome, DemoServer, WsUser, find_chrome, make_png  # noqa: E402

VIEWPORTS = [(320, 568), (360, 740), (390, 844), (844, 390), (768, 1024), (1280, 800), (1920, 1080)]
PNG = make_png()


@pytest.fixture(scope="session")
def chrome_proc():
    path = find_chrome()
    if not path:
        pytest.skip("Chrome not found (set CHROME_PATH to run the UI tests)")
    chrome = Chrome(path)
    yield chrome
    chrome.stop()


@pytest.fixture(scope="session")
def servers():
    started: dict[str, DemoServer] = {}

    def get(features: str) -> DemoServer:
        if features not in started:
            started[features] = DemoServer(features)
        return started[features]

    yield get
    for srv in started.values():
        srv.stop()


async def _seed(srv: DemoServer) -> None:
    """A small, realistic history: Alice <-> Bob (text, photo, file, read ticks) and a missed call + unread from Carol."""
    async with WsUser(srv, "U1") as alice, WsUser(srv, "U2") as bob, WsUser(srv, "U3") as carol:
        async def say(user: WsUser, to: str, text: str) -> None:
            await user.send("send_message", candidate_user_id=to, content=text, message_type="text")
            await user.wait_for("message_sent", lambda f: f["message"]["content"] == text)

        await say(bob, "U1", "Hey Alice! Are we still on for the design review tomorrow?")
        await say(alice, "U2", "Yes, 10:30 works for me.")
        await say(alice, "U2", "I'll bring the new call screens.")
        await say(bob, "U1", "Perfect. Can you send the mockup?")
        await alice.send("media_upload", target_user_id="U2", file_name="call-screen.png", file_type="image/png",
                         file_data=base64.b64encode(PNG).decode())
        await alice.wait_for("message_sent", lambda f: f["message"]["message_type"] == "image")
        await say(bob, "U1", "Love the gradient 😍")
        await bob.send("media_upload", target_user_id="U1", file_name="review-notes.txt", file_type="text/plain",
                       file_data=base64.b64encode(b"1. Spacing\n2. Dark mode\n3. Call states\n" * 20).decode())
        await bob.wait_for("message_sent", lambda f: f["message"].get("file_name") == "review-notes.txt")
        await say(alice, "U2", "Thanks! Reading it now.")
        chat_ab = (await alice.chat_id_with("U2"))
        await alice.send("mark_read", chat_id=chat_ab)
        await bob.send("mark_read", chat_id=chat_ab)
        await bob.wait_for("chat_read")

        # Carol calls and hangs up before Alice answers -> "Missed voice call", then leaves a note.
        await carol.send("call_initiate", receiver_id="U1", call_type="audio")
        call = await carol.wait_for("call_initiated")
        await alice.wait_for("incoming_call")
        await carol.send("end_call", call_id=call["call_id"])
        await carol.wait_for("call_log")
        await say(carol, "U1", "Call me when you're free?")


@pytest.fixture(scope="session")
def seeded(servers) -> DemoServer:
    """The chat+call server with seeded history."""
    srv = servers("chat,call")
    asyncio.run(_seed(srv))
    return srv


class Browser:
    def __init__(self, cdp: CDP) -> None:
        self.cdp = cdp
        self.pages = []

    async def new_page(self, *args, **kwargs):
        page = await self.cdp.new_page(*args, **kwargs)
        self.pages.append(page)
        return page


@pytest.fixture
async def browser(chrome_proc):
    cdp = await CDP.connect(chrome_proc.ws_url)
    b = Browser(cdp)
    yield b
    for page in b.pages:
        await page.close()
    await cdp.close()
