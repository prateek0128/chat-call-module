"""Calls in the browser: a real two-page WebRTC call (fake mic), and the failure screens."""

from __future__ import annotations

import asyncio
import json
import re

from _harness import HIT_TEST_JS, OVERFLOW_JS, WsUser

THREAD_READY = "DemoApp.S.thread.loaded && !document.querySelector('#msgList[aria-busy]') && !document.getElementById('thread').hidden"
STATE = "(callScreen.hidden ? 'hidden' : callScreen.dataset.state)"


async def open_chat(browser, srv, me, peer, w, h, **kw):
    page = await browser.new_page(w, h, **kw)
    await page.goto(f"{srv.base}/#{me}:{peer}")
    await page.wait(THREAD_READY)
    await page.wait("document.getElementById('connState').dataset.state === 'online'")
    return page


async def reachable(page, *selectors):
    assert not await page.eval(OVERFLOW_JS)
    for sel in selectors:
        res = await page.eval(f"({HIT_TEST_JS})({json.dumps(sel)})")
        assert res["ok"], res


async def test_two_browsers_call_accept_mute_hang_up(browser, seeded):
    alice = await open_chat(browser, seeded, "U1", "U2", 1280, 800)
    bob = await open_chat(browser, seeded, "U2", "U1", 390, 844)
    entries = "document.querySelectorAll('#msgList .call-entry').length"
    a_before, b_before = await alice.eval(entries), await bob.eval(entries)

    await alice.click("#callBtn")
    await alice.wait(f"{STATE} === 'ringing'", what="caller sees Ringing…")
    assert await alice.eval("document.getElementById('callStatus').textContent") == "Ringing…"
    assert await alice.eval("callScreen.dataset.ringing") == "true"
    await alice.screenshot("desktop-1280x800-call-ringing")
    await bob.wait(f"{STATE} === 'incoming'", what="callee sees the incoming screen")
    await asyncio.sleep(0.3)
    await bob.click("[data-act='accept']")
    await bob.wait(f"{STATE} === 'active'", timeout=20, what="callee connected")
    await alice.wait(f"{STATE} === 'active'", timeout=20, what="caller connected")
    await asyncio.sleep(1.2)
    status = await alice.eval("document.getElementById('callStatus').textContent")
    assert re.fullmatch(r"\d\d:\d\d", status), status
    await reachable(bob, "[data-act='mute']", "[data-act='hangup']")
    await bob.screenshot("phone-390x844-call-active")

    await alice.click("[data-act='mute']")
    assert await alice.eval("document.querySelector('[data-act=mute]').getAttribute('aria-pressed')") == "true"
    assert await alice.eval("DemoApp.S.call.stream.getAudioTracks().every(t => !t.enabled)")
    if await alice.eval("'setSinkId' in HTMLMediaElement.prototype"):
        await alice.click("[data-act='output']")
        await alice.wait("!document.getElementById('callMenu').hidden")
        await asyncio.sleep(0.3)
        await alice.screenshot("desktop-1280x800-call-active-output-menu")
        await alice.press("Escape")
        await alice.wait("document.getElementById('callMenu').hidden")
        assert await alice.eval("document.activeElement.dataset.act") == "output"
        assert await alice.eval(STATE) == "active", "Escape closes only the menu"
    else:
        await alice.screenshot("desktop-1280x800-call-active")

    await alice.click("[data-act='hangup']")
    await alice.wait(f"{STATE} === 'ended'")
    assert re.fullmatch(r"Call ended · \d\d:\d\d", await alice.eval("document.getElementById('callStatus').textContent"))
    await alice.screenshot("desktop-1280x800-call-ended")
    await bob.wait(f"{STATE} === 'ended' || {STATE} === 'hidden'")
    await alice.wait("callScreen.hidden", timeout=5, what="auto-close after 1.6 s")
    await bob.wait("callScreen.hidden", timeout=5)
    for page, before in ((alice, a_before), (bob, b_before)):
        await page.wait(f"{entries} === {before + 1}", what="call log entry")
        text = await page.eval("[...document.querySelectorAll('#msgList .call-entry')].pop().textContent")
        assert "Voice call" in text and re.search(r"\d\d:\d\d", text), text
    assert await alice.eval("document.activeElement.id") == "callBtn", "focus returns to the call button"


async def test_mic_blocked_shows_how_to_allow_it(browser, seeded):
    deny = """navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));"""
    page = await open_chat(browser, seeded, "U1", "U3", 360, 740, init_script=deny)
    await asyncio.sleep(0.3)
    await page.click("#callBtn")
    await page.wait(f"{STATE} === 'failed'", what="failure screen")
    assert await page.eval("document.getElementById('callStatus').textContent") == "Microphone access is blocked"
    detail = await page.eval("document.getElementById('callDetail').textContent")
    assert "Allow" in detail and "settings" in detail
    await asyncio.sleep(0.3)
    await reachable(page, "#callDetail", "[data-act='close']", "[data-act='again']")
    await page.screenshot("phone-360x740-call-mic-blocked")
    await page.click("[data-act='close']")
    await page.wait("callScreen.hidden")
    assert await page.eval("document.activeElement.id") == "callBtn"


async def test_declined_by_callee_offers_call_again(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2", 844, 390)
    async with WsUser(seeded, "U2") as bob:
        await page.click("#callBtn")
        incoming = await bob.wait_for("incoming_call")
        await page.wait(f"{STATE} === 'ringing'")
        await bob.send("reject_call", call_id=incoming["call_id"])
        await page.wait(f"{STATE} === 'failed'", what="declined screen")
        assert await page.eval("document.getElementById('callStatus').textContent") == "Declined"
        await asyncio.sleep(0.3)
        await reachable(page, "[data-act='close']", "[data-act='again']")
        await page.screenshot("phone-844x390-call-declined")
        await page.click("[data-act='again']")
        again = await bob.wait_for("incoming_call")
        await page.wait(f"['outgoing','ringing'].includes({STATE})", what="calling again")
        await page.click("[data-act='hangup']")
        await bob.wait_for("call_ended", lambda f: f["call_id"] == again["call_id"])
        await page.wait("callScreen.hidden", timeout=5)


async def test_no_answer_and_busy_reasons(browser, seeded):
    page = await open_chat(browser, seeded, "U1", "U2", 1280, 800)
    # No answer: the server sends call_missed after a 45 s ring timeout; feed that frame directly.
    await page.click("#callBtn")
    await page.wait("!!(DemoApp.S.call && DemoApp.S.call.id)", what="call id")
    call_id = await page.eval("DemoApp.S.call.id")
    await page.eval(f"window.CallUI.handle({{type: 'call_missed', call_id: {json.dumps(call_id)}}})")
    await page.wait(f"{STATE} === 'failed'")
    assert await page.eval("document.getElementById('callStatus').textContent") == "No answer"
    await page.eval(f"DemoApp.send('end_call', {{call_id: {json.dumps(call_id)}}})")  # end it on the server too
    await asyncio.sleep(0.3)
    await page.screenshot("desktop-1280x800-call-no-answer")
    await page.click("[data-act='close']")
    await page.wait("callScreen.hidden")

    # Busy: Bob is in a live call with Carol -> call_rejected with call_id null.
    async with WsUser(seeded, "U3") as carol, WsUser(seeded, "U2") as bob:
        await carol.send("call_initiate", receiver_id="U2", call_type="audio")
        incoming = await bob.wait_for("incoming_call")
        await bob.send("answer_call", call_id=incoming["call_id"])
        await carol.wait_for("call_answered")
        await page.click("#callBtn")
        await page.wait(f"{STATE} === 'failed'", what="busy screen")
        assert await page.eval("document.getElementById('callStatus').textContent") == "On another call"
        assert "Bob is on another call" in await page.eval("document.getElementById('callDetail').textContent")
        await asyncio.sleep(0.3)
        await page.screenshot("desktop-1280x800-call-busy")
        await page.click("[data-act='close']")
        await page.wait("callScreen.hidden")
        await carol.send("end_call", call_id=incoming["call_id"])
        await carol.wait_for("call_ended")
