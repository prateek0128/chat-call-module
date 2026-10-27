"""Responsive layout: every viewport, list -> chat -> incoming call, no overflow, key controls reachable."""

from __future__ import annotations

import asyncio
import json

import pytest

from _harness import HIT_TEST_JS, OVERFLOW_JS, WsUser
from conftest import VIEWPORTS

THREAD_READY = "DemoApp.S.thread.loaded && !document.querySelector('#msgList[aria-busy]') && !document.getElementById('thread').hidden"


async def assert_layout(page, selectors: list[str], *, min_tap: list[str] = ()) -> None:
    overflow = await page.eval(OVERFLOW_JS)
    assert not overflow, f"horizontal overflow at {page.width}x{page.height}: {overflow}"
    for sel in selectors:
        res = await page.eval(f"({HIT_TEST_JS})({json.dumps(sel)})")
        assert res["ok"], f"{sel} not fully visible/reachable at {page.width}x{page.height}: {res}"
    for sel in min_tap:
        r = await page.rect(sel)
        assert r["w"] >= 43.5 and r["h"] >= 43.5, f"{sel} smaller than the 44px tap target: {r}"


def tag(w: int, h: int) -> str:
    kind = "phone" if (w < 700 or h < 500) else "tablet" if w < 1024 else "desktop"
    return f"{kind}-{w}x{h}"


@pytest.mark.parametrize("w,h,scheme", [(320, 568, "light"), (1280, 800, "light"), (390, 844, "dark")])
async def test_sign_in_screen(browser, seeded, w, h, scheme):
    page = await browser.new_page(w, h, media={"prefers-color-scheme": scheme})
    await page.goto(seeded.base + "/")
    await page.wait("document.querySelectorAll('#whoList .who-btn').length === 3", what="demo users")
    await asyncio.sleep(0.2)
    await assert_layout(page, ["#whoList .who-btn[data-id='U1']", "#whoList .who-btn[data-id='U3']", "#login .theme-btn"])
    assert await page.eval("document.getElementById('features').textContent") == "ChatVoice calls"
    await page.screenshot(f"{tag(w, h)}-0-sign-in-{scheme}")
    await page.click("#whoList .who-btn[data-id='U2']")
    await page.wait("location.hash === '#U2' && !document.getElementById('app').hidden")


@pytest.mark.parametrize("w,h", VIEWPORTS, ids=[f"{w}x{h}" for w, h in VIEWPORTS])
async def test_layout_list_chat_call(browser, seeded, w, h):
    srv = seeded
    page = await browser.new_page(w, h)
    await page.goto(srv.base + "/#U1")
    await page.wait("document.querySelectorAll('#convoList .convo:not(.skeleton)').length >= 2", what="conversation list")
    await page.wait("document.getElementById('connState').dataset.state === 'online'", what="online")
    await asyncio.sleep(0.3)
    await assert_layout(page, ["#listPane .list-bar", "#search", ".convo[data-id='U2']", "#devBtn", "#logoutBtn"],
                        min_tap=["#devBtn", "#logoutBtn"])
    await page.screenshot(f"{tag(w, h)}-1-list")

    # open the chat with Bob
    await page.click(".convo[data-id='U2']")
    await page.wait(THREAD_READY, what="thread loaded")
    await asyncio.sleep(0.4)  # pane slide (phone)
    keys = ["#chatPane .chat-bar", "#peerName", "#composer", "#attachBtn", "#text", "#sendBtn", "#callBtn"]
    if w < 700:
        keys.append("#backBtn")
        assert await page.eval("document.getElementById('app').dataset.pane") == "chat"
    await assert_layout(page, keys, min_tap=["#attachBtn", "#sendBtn", "#callBtn"])
    assert await page.eval("document.querySelectorAll('#msgList .msg').length") >= 6
    await page.screenshot(f"{tag(w, h)}-2-chat")

    if w < 700 and h > 500:
        # virtual keyboard: the layout viewport shrinks; composer + header must stay on screen
        await page.click("#text")
        await page.set_viewport(w, int(h * 0.55))
        await asyncio.sleep(0.3)
        await assert_layout(page, ["#chatPane .chat-bar", "#composer", "#sendBtn"])
        await page.screenshot(f"{tag(w, h)}-3-keyboard")
        await page.set_viewport(w, h)
        await page.eval("document.activeElement.blur()")
        await asyncio.sleep(0.2)

    # incoming call from Carol (scripted)
    async with WsUser(srv, "U3") as carol:
        await carol.send("call_initiate", receiver_id="U1", call_type="audio")
        await carol.wait_for("call_initiated")
        await page.wait("!callScreen.hidden && callScreen.dataset.state === 'incoming'", what="incoming call screen")
        await asyncio.sleep(0.35)
        await assert_layout(page, ["#callName", "#callStatus", "[data-act='decline']", "[data-act='accept']"],
                            min_tap=["[data-act='decline']", "[data-act='accept']"])
        assert await page.eval("callScreen.contains(document.activeElement)"), "focus should move into the call screen"
        await page.screenshot(f"{tag(w, h)}-4-call-incoming")
        await page.click("[data-act='decline']")
        await carol.wait_for("call_rejected")
        await page.wait("callScreen.dataset.state === 'ended'", what="ended state")
        await page.wait("callScreen.hidden", timeout=5, what="call screen auto-close")
