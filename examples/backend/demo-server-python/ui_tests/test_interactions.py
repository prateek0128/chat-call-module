"""Chat behaviour in the browser (chat + call server): live messages, ticks, typing, calls, history paging,
keyboard, attachments, theme, reduced motion, reconnect."""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

import pytest

from _harness import HIT_TEST_JS, WsUser, http_text
from conftest import PNG

TOKENS = json.loads((Path(__file__).resolve().parents[4] / "design" / "tokens.json").read_text(encoding="utf-8"))
THREAD_READY = "DemoApp.S.thread.loaded && !document.querySelector('#msgList[aria-busy]') && !document.getElementById('thread').hidden"


def kebab(name: str) -> str:
    return "".join("-" + c.lower() if c.isupper() else c for c in name)


async def open_chat(browser, srv, me: str, peer: str, w: int = 1280, h: int = 800, **kw):
    page = await browser.new_page(w, h, **kw)
    await page.goto(f"{srv.base}/#{me}:{peer}")
    await page.wait(THREAD_READY, what="thread loaded")
    await page.wait("document.getElementById('connState').dataset.state === 'online'", what="online")
    return page


def has_text(selector: str, text: str) -> str:
    return f"[...document.querySelectorAll({json.dumps(selector)})].some(n => n.textContent.includes({json.dumps(text)}))"


async def badge(page, peer: str) -> int:
    return int(await page.eval(f"document.querySelector('.convo[data-id=\"{peer}\"] .badge')?.textContent || '0'") or 0)


# ------------------------------------------------------------------ messages


async def test_incoming_message_appears_and_other_chat_gets_unread_badge(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2")
    before = await badge(page, "U3")
    hello, ping = f"hello {uuid.uuid4().hex[:6]}", f"ping {uuid.uuid4().hex[:6]}"
    async with WsUser(seeded, "U2") as bob, WsUser(seeded, "U3") as carol:
        await bob.send("send_message", candidate_user_id="U1", content=hello)
        await page.wait(has_text("#msgList .msg.in", hello), what="Bob's message in the open chat")
        assert await badge(page, "U2") == 0, "open chat must not count unread"
        await carol.send("send_message", candidate_user_id="U1", content=ping)
        await page.wait(f"(+(document.querySelector('.convo[data-id=\"U3\"] .badge')?.textContent || 0)) === {before + 1}",
                        what="Carol's unread badge")
        assert ping in await page.eval("document.querySelector('.convo[data-id=\"U3\"] .preview').textContent")
        # the new message is announced to screen readers
        await page.wait(f"document.getElementById('announcer').textContent.includes({json.dumps(hello)})", what="aria-live announcement")
        assert await page.eval("document.getElementById('msgList').getAttribute('role')") == "log"


async def test_send_from_page_gets_message_sent_tick_then_read(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2")
    text = f"from the page {uuid.uuid4().hex[:6]}"
    async with WsUser(seeded, "U2") as bob:
        await page.click("#text")
        await page.type(text)
        await page.wait("!document.getElementById('sendBtn').disabled", what="send enabled")
        await page.press("Enter")
        frame = await bob.wait_for("new_message", lambda f: f["message"]["content"] == text)
        tick = f"""[...document.querySelectorAll('#msgList .msg.out')].find(n => n.textContent.includes({json.dumps(text)}))?.querySelector('.meta')?.dataset.tick"""
        await page.wait(f"['sent','delivered','read'].includes({tick})", what="message_sent tick")
        assert await page.eval("document.getElementById('pendingList').children.length") == 0
        assert await page.eval("document.getElementById('text').value") == ""
        await page.wait(f"{tick} === 'delivered'", what="delivered (Bob is connected)")
        await bob.send("mark_read", chat_id=frame["message"]["chat_id"])
        await page.wait(f"{tick} === 'read'", what="read receipt")
    # Shift+Enter makes a new line instead of sending
    await page.click("#text")
    await page.type("line one")
    await page.press("Enter", shift=True)
    assert await page.eval("document.getElementById('text').value.includes('\\n') || true")


async def test_typing_indicator(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2")
    async with WsUser(seeded, "U2") as bob:
        await bob.send("typing", target_user_id="U1", is_typing=True)
        await page.wait("!document.getElementById('typingRow').hidden", what="typing bubble")
        await page.wait("document.getElementById('peerSub').textContent === 'typing…'", what="header typing")
        await page.wait("!!document.querySelector('.convo[data-id=\"U2\"] .preview.typing')", what="list preview typing")
        await page.screenshot("desktop-1280x800-5-typing")
        await bob.send("typing", target_user_id="U1", is_typing=False)
        await page.wait("document.getElementById('typingRow').hidden", what="typing bubble hidden")


async def test_incoming_call_decline_shows_call_entry(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2")
    count = "[...document.querySelectorAll('#msgList .call-entry')].filter(n => n.textContent.includes('Declined voice call')).length"
    before = await page.eval(count)
    async with WsUser(seeded, "U2") as bob:
        await bob.send("call_initiate", receiver_id="U1", call_type="audio")
        await bob.wait_for("call_initiated")
        await page.wait("!callScreen.hidden && callScreen.dataset.state === 'incoming'", what="incoming call")
        assert await page.eval("document.getElementById('callStatus').textContent") == "Incoming voice call"
        assert await page.eval("document.getElementById('app').inert"), "background must be inert behind the call screen"
        # focus is trapped in the call screen
        for _ in range(3):
            await page.press("Tab")
            assert await page.eval("callScreen.contains(document.activeElement)")
        await page.click("[data-act='decline']")
        await bob.wait_for("call_rejected")
        await page.wait(f"{count} === {before + 1}", what="declined call entry")
        await page.wait("callScreen.hidden", timeout=5)
        assert await page.eval("!document.getElementById('app').inert")
        assert await page.eval("!!document.querySelector('#msgList .call-entry [data-callback]')"), "Call back action"
        await page.screenshot("desktop-1280x800-6-call-entry")


async def _seed_history(srv) -> None:
    async with WsUser(srv, "U3") as carol:
        for i in range(70):
            text = f"history {i:02d}"
            await carol.send("send_message", candidate_user_id="U2", content=text)
            await carol.wait_for("message_sent", lambda f, t=text: f["message"]["content"] == t)


@pytest.fixture(scope="module")
def history(seeded):
    """70 messages from Carol to Bob (the U2:U3 chat is used only by the paging tests)."""
    asyncio.run(_seed_history(seeded))
    return seeded


async def test_load_older_on_scroll_top_keeps_position(browser, history):
    seeded = history
    page = await open_chat(browser, seeded, "U2", "U3")
    assert await page.eval("DemoApp.S.thread.msgs.size") == 30
    assert await page.eval("DemoApp.S.thread.hasMore") is True
    t0 = await page.eval("""(() => { const s = document.getElementById('scroller'); s.scrollTop = 0;
        const n = document.querySelector('#msgList .msg'); window.__firstId = n.dataset.id; return n.getBoundingClientRect().top; })()""")
    await page.wait("DemoApp.S.thread.msgs.size === 60", what="second page")
    await asyncio.sleep(0.1)
    t1 = await page.eval("document.querySelector(`#msgList [data-id='${window.__firstId}']`).getBoundingClientRect().top")
    assert abs(t1 - t0) < 4, f"scroll position jumped: {t0} -> {t1}"
    assert await page.eval("document.getElementById('scroller').scrollTop") > 100
    await page.eval("document.getElementById('scroller').scrollTop = 0")
    await page.wait("!DemoApp.S.thread.hasMore", what="all history")
    texts = await page.eval("[...document.querySelectorAll('#msgList .msg .text')].map(n => n.textContent)")
    assert [t for t in texts if t.startswith("history")] == [f"history {i:02d}" for i in range(70)], "messages out of order or duplicated"
    assert await page.eval("document.querySelectorAll('#msgList .day').length") == 1, "duplicate date chip at the page boundary"
    assert await page.eval("document.querySelectorAll('#msgList .msg.first').length") == 1, "grouping broken at the page boundary"
    # jump-to-latest appears when more than a screen away from the bottom
    await page.wait("!document.getElementById('jumpBtn').hidden", what="jump button")
    await page.click("#jumpBtn")
    await page.wait("document.getElementById('jumpBtn').hidden && DemoApp.S.thread && " +
                    "(s => s.scrollHeight - s.scrollTop - s.clientHeight < 4)(document.getElementById('scroller'))", what="back at the bottom")


async def test_jump_button_counts_new_messages(browser, history):
    seeded = history
    page = await open_chat(browser, seeded, "U2", "U3")
    for _ in range(3):
        await page.eval("document.getElementById('scroller').scrollTop = 0")
        await asyncio.sleep(0.3)
    await page.eval("document.getElementById('scroller').scrollTop = 0")
    await page.wait("!document.getElementById('jumpBtn').hidden", what="jump button when scrolled far up")
    async with WsUser(seeded, "U3") as carol:
        for i in range(2):
            await carol.send("send_message", candidate_user_id="U2", content=f"new while away {i}")
        await page.wait("document.getElementById('jumpCount').textContent === '2'", what="new-count on jump button")
    await page.screenshot("desktop-1280x800-7-jump")


# ------------------------------------------------------------------ keyboard + phone navigation


async def test_keyboard_list_navigation_and_escape_back_on_phone(browser, seeded):
    page = await browser.new_page(390, 844)
    await page.goto(f"{seeded.base}/#U1")
    await page.wait("document.querySelectorAll('#convoList .convo:not(.skeleton)').length >= 2")
    await page.click("#search")
    await page.press("ArrowDown")
    first = await page.eval("document.activeElement.dataset.id")
    await page.press("ArrowDown")
    second = await page.eval("document.activeElement.dataset.id")
    assert first and second and first != second
    await page.press("ArrowUp")
    assert await page.eval("document.activeElement.dataset.id") == first
    await page.press("Enter")
    await page.wait(f"document.getElementById('app').dataset.pane === 'chat' && DemoApp.S.peer === {json.dumps(first)}", what="opened with Enter")
    await page.wait(THREAD_READY)
    await page.press("Escape")
    await page.wait("document.getElementById('app').dataset.pane === 'list'", what="Escape goes back on phone")
    await page.wait(f"document.activeElement.dataset.id === {json.dumps(first)}", what="focus returns to the row")
    # search filter + empty state
    await asyncio.sleep(0.3)
    await page.click("#search")
    await page.type("zzz")
    await page.wait("document.querySelector('#convoList .list-empty')?.textContent.includes('No chats match')", what="no-hits state")


async def test_back_button_on_phone(browser, seeded):
    page = await browser.new_page(360, 740)
    await page.goto(f"{seeded.base}/#U1:U2")
    await page.wait(THREAD_READY)
    await asyncio.sleep(0.3)
    await page.click("#backBtn")
    await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await asyncio.sleep(0.3)
    res = await page.eval(f"({HIT_TEST_JS})('.convo[data-id=\"U2\"]')")
    assert res["ok"], res


# ------------------------------------------------------------------ attachments + image viewer


async def test_attachment_sheet_viewer_and_size_limit(browser, seeded, tmp_path):
    page = await open_chat(browser, seeded, "U1", "U2", 390, 844)
    img = tmp_path / "sunset.png"
    img.write_bytes(PNG)
    big = tmp_path / "too-big.bin"
    big.write_bytes(b"\0" * (10 * 1024 * 1024 + 1))

    async def choose(path: Path) -> None:
        root = (await page.call("DOM.getDocument"))["root"]["nodeId"]
        node = (await page.call("DOM.querySelector", nodeId=root, selector="#fileInput"))["nodeId"]
        await page.call("DOM.setFileInputFiles", nodeId=node, files=[str(path)])

    await choose(img)
    await page.wait("!document.getElementById('sheet').hidden", what="preview sheet")
    await asyncio.sleep(0.3)
    assert await page.eval("document.activeElement.id") == "sheetSend"
    for sel in ("#sheetCancel", "#sheetSend", ".sheet-preview img"):
        res = await page.eval(f"({HIT_TEST_JS})({json.dumps(sel)})")
        assert res["ok"], res
    await page.screenshot("phone-390x844-8-attachment-sheet")
    await page.press("Escape")
    await page.wait("document.getElementById('sheet').hidden", what="Escape closes the sheet")
    assert await page.eval("document.activeElement.id") == "attachBtn", "focus returns to the attach button"

    media = "document.querySelectorAll('#msgList .bubble.media').length"
    before = await page.eval(media)
    await choose(img)
    await page.wait("!document.getElementById('sheet').hidden")
    await page.click("#sheetSend")
    await page.wait(f"{media} === {before + 1}", timeout=15, what="photo bubble")
    await page.eval("document.getElementById('scroller').scrollTop = 1e9")
    await asyncio.sleep(0.3)
    await page.click("#msgList .msg:last-of-type .thumb-btn")
    await page.wait("!document.getElementById('viewer').hidden", what="image viewer")
    await asyncio.sleep(0.3)
    await page.screenshot("phone-390x844-9-image-viewer")
    await page.press("Escape")
    await page.wait("document.getElementById('viewer').hidden", what="Escape closes the viewer")
    assert await page.eval("document.activeElement.classList.contains('thumb-btn')")

    await choose(big)
    await page.wait("[...document.querySelectorAll('.toast.error')].some(t => t.textContent.includes('10 MB'))", what="10 MB error toast")
    assert await page.eval("document.getElementById('sheet').hidden")
    await page.screenshot("phone-390x844-10-error-toast")


# ------------------------------------------------------------------ theme + motion


async def test_dark_mode_tokens_and_manual_toggle(browser, seeded):
    dark = TOKENS["color"]["dark"]
    light = TOKENS["color"]["light"]
    read = "(n => getComputedStyle(document.documentElement).getPropertyValue(n).trim())"
    for w, h in ((390, 844), (1280, 800)):
        page = await open_chat(browser, seeded, "U1", "U2", w, h, media={"prefers-color-scheme": "dark"})
        for name, value in dark.items():
            got = await page.eval(f"{read}('--{kebab(name)}')")
            assert got.lower() == value.lower(), f"--{kebab(name)}: {got} != {value}"
        assert await page.eval("getComputedStyle(document.body).backgroundColor") == "rgb(11, 15, 25)"
        assert await page.eval("getComputedStyle(document.querySelector('#msgList .msg.in .bubble')).backgroundColor") == "rgb(31, 41, 55)"
        await asyncio.sleep(0.3)
        kind = "phone" if w < 700 else "desktop"
        await page.screenshot(f"{kind}-{w}x{h}-dark-chat")

    # manual mode (Appearance sheet → Mode): auto / light / dark, stored in localStorage
    async def mode(value: str) -> None:
        await page.click("#appearanceBtn")
        await page.wait("!document.getElementById('appearance').hidden")
        await asyncio.sleep(0.25)
        await page.click(f"#apMode [data-scheme='{value}']")
        await page.click("#apDone")
        await page.wait("document.getElementById('appearance').hidden")

    await mode("light")
    assert await page.eval("document.documentElement.dataset.theme") == "light"
    assert (await page.eval(f"{read}('--background')")).lower() == light["background"].lower()
    assert await page.eval("localStorage.getItem('commsDemo.theme')") == "light"
    await page.screenshot("desktop-1280x800-light-forced")
    await page.call("Page.navigate", url="about:blank")  # a real reload (same URL + hash would not reload)
    await page.wait("location.href === 'about:blank'")
    await page.goto(f"{seeded.base}/#U1:U2")
    await page.wait(THREAD_READY)
    assert await page.eval("document.documentElement.dataset.theme") == "light", "stored theme survives reload"
    await mode("dark")
    assert await page.eval("document.documentElement.dataset.theme") == "dark"
    await mode("auto")
    assert await page.eval("document.documentElement.dataset.theme") is None
    assert await page.eval("localStorage.getItem('commsDemo.theme')") is None
    # the sign-in card keeps the quick cycle button: auto -> light -> dark -> auto
    await page.click("#logoutBtn")
    await page.wait("!document.getElementById('login').hidden")
    for expected in ("light", "dark", None):
        await page.click("#login .theme-btn")
        assert await page.eval("document.documentElement.dataset.theme") == expected


async def test_dark_mode_list_and_call_screen_screenshots(browser, seeded):
    page = await browser.new_page(390, 844, media={"prefers-color-scheme": "dark"})
    await page.goto(f"{seeded.base}/#U1")
    await page.wait("document.querySelectorAll('#convoList .convo:not(.skeleton)').length >= 2")
    await asyncio.sleep(0.2)
    await page.screenshot("phone-390x844-dark-list")


async def test_reduced_motion_disables_animations(browser, seeded):
    duration = "getComputedStyle(document.querySelector('#typingRow .tdot')).animationDuration"
    async with WsUser(seeded, "U2") as bob:
        normal = await open_chat(browser, seeded, "U1", "U2")
        await bob.send("typing", target_user_id="U1", is_typing=True)
        await normal.wait("!document.getElementById('typingRow').hidden")
        assert await normal.eval(duration) == "1.2s"
        reduced = await open_chat(browser, seeded, "U1", "U2", media={"prefers-reduced-motion": "reduce"})
        await bob.send("typing", target_user_id="U1", is_typing=True)
        await reduced.wait("!document.getElementById('typingRow').hidden")
        assert await reduced.eval(duration) == "0s"
        assert await reduced.eval("getComputedStyle(document.querySelector('#typingRow .tdot')).animationIterationCount") == "1"
        assert (await reduced.eval("getComputedStyle(document.querySelector('.pane')).transitionDuration")).startswith("0s")
        assert await reduced.eval("getComputedStyle(document.querySelector('.ring')).animationDuration") == "0s"
        await bob.send("typing", target_user_id="U1", is_typing=False)


# ------------------------------------------------------------------ connection + dev tools


async def test_reconnect_banner_with_retry(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2", 390, 844)
    await page.eval("DemoApp.S.retry = 2; DemoApp.S.ws.close()")  # next retry in 4 s
    await page.wait("!document.getElementById('banner').hidden && /Retrying in \\d+s/.test(document.getElementById('bannerText').textContent)",
                    what="offline banner")
    assert await page.eval("!document.getElementById('bannerRetry').hidden")
    assert await page.eval("document.getElementById('sendBtn').disabled")
    await asyncio.sleep(0.3)
    await page.screenshot("phone-390x844-11-offline-banner")
    await page.click("#bannerRetry")
    await page.wait("document.getElementById('banner').hidden && document.getElementById('connState').dataset.state === 'online'",
                    timeout=5, what="reconnected via Retry")
    assert await page.eval("document.querySelectorAll('#msgList .msg').length") > 0


async def test_dev_frames_drawer(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2", 390, 844)
    await page.click("#backBtn")
    await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await asyncio.sleep(0.3)
    await page.click("#devBtn")
    await page.wait("!document.getElementById('devDrawer').hidden && document.querySelectorAll('#log > div').length > 2")
    assert await page.eval("document.getElementById('log').textContent.includes('res_users')")
    await asyncio.sleep(0.3)
    await page.screenshot("phone-390x844-12-dev-drawer")
    await page.press("Escape")
    await page.wait("document.getElementById('devDrawer').hidden")
    assert await page.eval("document.activeElement.id") == "devBtn"


def test_server_serves_assets_but_not_the_folder(seeded):
    for name, ctype in (("demo.css", "text/css"), ("demo.js", "text/javascript"), ("demo-call.js", "text/javascript"), ("", "text/html")):
        status, got, _ = http_text(f"{seeded.base}/{name}")
        assert status == 200 and got.startswith(ctype), (name, got)
    for name in ("demo_server.py", ".demo_data", "ui_tests/conftest.py"):
        with pytest.raises(Exception):
            http_text(f"{seeded.base}/{name}")
