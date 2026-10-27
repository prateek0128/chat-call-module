"""COMMS_FEATURES=chat (no call code at all) and COMMS_FEATURES=call (no composer / messages)."""

from __future__ import annotations

import asyncio
import json

import pytest

from _harness import HIT_TEST_JS, OVERFLOW_JS, WsUser

THREAD_READY = "DemoApp.S.thread.loaded && !document.querySelector('#msgList[aria-busy]') && !document.getElementById('thread').hidden"

# Counts every getUserMedia call, so we can prove chat-only never touches the microphone.
GUM_SPY = """
window.__gum = 0;
if (navigator.mediaDevices) {
  const real = navigator.mediaDevices.getUserMedia?.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (...a) => { window.__gum++; return real(...a); };
}
"""


async def check(page, selectors):
    overflow = await page.eval(OVERFLOW_JS)
    assert not overflow, overflow
    for sel in selectors:
        res = await page.eval(f"({HIT_TEST_JS})({json.dumps(sel)})")
        assert res["ok"], res


@pytest.fixture(scope="module")
def chat_only(servers):
    srv = servers("chat")

    async def seed():
        async with WsUser(srv, "U2") as bob:
            await bob.send("send_message", candidate_user_id="U1", content="Chat-only server: no call button here.")
            await bob.wait_for("message_sent")
    asyncio.run(seed())
    return srv


@pytest.mark.parametrize("w,h", [(360, 740), (1280, 800)])
async def test_chat_only_has_no_call_ui_and_never_loads_call_code(browser, chat_only, w, h):
    page = await browser.new_page(w, h, init_script=GUM_SPY)
    await page.goto(f"{chat_only.base}/#U1:U2")
    await page.wait(THREAD_READY)
    await page.wait("document.getElementById('connState').dataset.state === 'online'")
    await asyncio.sleep(0.4)
    assert await page.eval("document.getElementById('callBtn').hidden") is True
    assert await page.eval("document.getElementById('callBtn').getClientRects().length") == 0
    assert await page.eval("typeof window.CallUI") == "undefined"
    assert await page.eval("performance.getEntriesByType('resource').filter(e => e.name.includes('demo-call.js')).length") == 0
    assert await page.eval("document.querySelectorAll('script[src*=\"demo-call\"]').length") == 0
    assert await page.eval("document.querySelectorAll('[data-callback]').length") == 0
    await check(page, ["#composer", "#text", "#sendBtn", "#attachBtn", "#chatPane .chat-bar"])
    await page.screenshot(f"{'phone' if w < 700 else 'desktop'}-{w}x{h}-chat-only")
    # chat still works end to end
    await page.click("#text")
    await page.type("works without calls")
    await page.press("Enter")
    await page.wait("[...document.querySelectorAll('#msgList .msg.out .meta')].some(m => ['sent','delivered','read'].includes(m.dataset.tick))")
    assert await page.eval("window.__gum") == 0, "chat-only must never call getUserMedia"
    assert "Voice calls" not in await page.eval("document.body.textContent.replace(/\\s+/g, ' ')")


@pytest.mark.parametrize("w,h", [(390, 844), (844, 390), (1280, 800)])
async def test_call_only_shows_people_to_call_and_no_composer(browser, servers, w, h):
    srv = servers("call")
    page = await browser.new_page(w, h)
    await page.goto(f"{srv.base}/#U1")
    await page.wait("document.querySelectorAll('#convoList .convo:not(.skeleton)').length === 2")
    await page.wait("document.getElementById('connState').dataset.state === 'online'")
    assert await page.eval("document.getElementById('listTitle').textContent") == "Calls"
    tag = f"{'phone' if (w < 700 or h < 500) else 'desktop'}-{w}x{h}"
    await asyncio.sleep(0.3)
    await page.screenshot(f"{tag}-call-only-list")
    await page.click(".convo[data-id='U2']")
    await page.wait("!document.getElementById('callsOnly').hidden")
    await asyncio.sleep(0.4)
    for sel in ("#composer", "#msgList", "#threadBody"):
        assert await page.eval(f"document.querySelector('{sel}').getClientRects().length") == 0, f"{sel} must not show in call-only mode"
    assert await page.eval("DemoApp.S.thread.loaded") is False
    await check(page, ["#callsOnlyCall", "#callsOnlyName", "#chatPane .chat-bar"])
    assert "Calls only" in await page.eval("document.getElementById('callsOnly').textContent")
    await page.screenshot(f"{tag}-call-only-panel")

    # place a call (fake microphone) -> outgoing screen -> cancel
    await page.click("#callsOnlyCall")
    await page.wait("!callScreen.hidden && ['outgoing','ringing'].includes(callScreen.dataset.state)", what="outgoing screen")
    await asyncio.sleep(0.4)
    has_sink = await page.eval("'setSinkId' in HTMLMediaElement.prototype")
    controls = ["[data-act='mute']", "[data-act='hangup']"] + (["[data-act='output']"] if has_sink else [])
    await check(page, ["#callName", "#callStatus", *controls])
    assert await page.eval("document.getElementById('callStatus').textContent") in ("Calling…", "Ringing…")
    await page.screenshot(f"{tag}-call-outgoing")
    await page.click("[data-act='hangup']")
    await page.wait("callScreen.dataset.state === 'ended'")
    await page.wait("callScreen.hidden", timeout=5)
    assert await page.eval("document.activeElement.id") == "callsOnlyCall", "focus returns to the trigger"
