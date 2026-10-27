"""The in-page Chat · Calls · Both switch (client-side mode, limited by the server's COMMS_FEATURES)."""

from __future__ import annotations

import asyncio
import json

import pytest

from _harness import HIT_TEST_JS, OVERFLOW_JS

THREAD_READY = "DemoApp.S.thread.loaded && !document.querySelector('#msgList[aria-busy]') && !document.getElementById('thread').hidden"
CALL_JS_LOADED = "performance.getEntriesByType('resource').filter(e => e.name.includes('demo-call.js')).length"
VISIBLE = "(sel) => { const el = document.querySelector(sel); return !!el && !el.hidden && el.getClientRects().length > 0; }"


async def visible(page, sel: str) -> bool:
    return await page.eval(f"({VISIBLE})({json.dumps(sel)})")


async def switch(page, mode: str) -> None:
    sel = f".mode-row [data-mode='{mode}']"
    # on phones the list pane slides in after "back"; click once it has settled
    await page.wait(f"({HIT_TEST_JS})({json.dumps(sel)}).ok", what=f"{sel} on screen")
    await page.click(sel)
    await page.wait(f"document.body.dataset.mode === '{mode}' && document.readyState === 'complete'",
                    timeout=15, what=f"reload into {mode} mode")
    await page.wait("document.getElementById('connState').dataset.state === 'online'")


@pytest.mark.parametrize("w,h", [(390, 844), (1280, 800)])
async def test_switch_between_chat_calls_and_both(browser, seeded, w, h):
    page = await browser.new_page(w, h)
    await page.goto(f"{seeded.base}/?mode=both#U1:U2")
    await page.wait(THREAD_READY)
    await page.wait("document.getElementById('connState').dataset.state === 'online'")
    assert await visible(page, "#callBtn") and await visible(page, "#composer")
    tag = f"{'phone' if w < 700 else 'desktop'}-{w}x{h}"

    # Chat only: reload without any call code, same user and open conversation.
    if w < 700:  # the switch lives in the list pane; go back to it on phones
        await page.click("#backBtn")
        await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await switch(page, "chat")
    assert await page.eval("location.search") == "?mode=chat"
    assert await page.eval("DemoApp.S.me") == "U1"
    assert await page.eval("typeof window.CallUI") == "undefined"
    assert await page.eval(CALL_JS_LOADED) == 0
    if w < 700:  # phones switched from the list, so reopen the chat
        await page.click(".convo[data-id='U2']")
    await page.wait(THREAD_READY)
    assert await page.eval("DemoApp.S.peer") == "U2"  # desktop: the open chat survives the reload
    assert not await visible(page, "#callBtn")
    assert await visible(page, "#composer")
    assert await page.eval("document.querySelector(\".mode-row [aria-checked='true']\").dataset.mode") == "chat"

    # Calls only: no composer, list titled Calls, call code loaded.
    if w < 700:
        await page.click("#backBtn")
        await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await switch(page, "call")
    assert await page.eval("document.getElementById('listTitle').textContent") == "Calls"
    assert await page.eval("typeof window.CallUI") == "object"
    if w >= 700:
        await page.wait("!document.getElementById('callsOnly').hidden")
        assert not await visible(page, "#composer")
    await page.screenshot(f"{tag}-mode-calls")

    # Both again.
    if w < 700 and await page.eval("document.getElementById('app').dataset.pane") != "list":
        await page.click("#backBtn")
        await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await switch(page, "both")
    if w < 700:
        await page.click(".convo[data-id='U2']")
    await page.wait(THREAD_READY)
    assert await visible(page, "#callBtn") and await visible(page, "#composer")
    assert not await page.eval(OVERFLOW_JS)


async def test_choice_is_remembered_without_the_url_param(browser, seeded):
    page = await browser.new_page(1280, 800)
    await page.goto(f"{seeded.base}/#U1")
    await page.wait("document.getElementById('connState').dataset.state === 'online'")
    await switch(page, "chat")
    await page.goto(f"{seeded.base}/#U1")  # no ?mode= : falls back to the stored choice
    assert await page.eval("document.body.dataset.mode") == "chat"


async def test_sign_in_card_switch_and_disabled_options(browser, servers):
    srv = servers("chat")
    page = await browser.new_page(320, 568)
    await page.goto(f"{srv.base}/?mode=call")
    await page.wait("document.querySelectorAll('.who-btn').length === 3")
    # The server has no calls: an impossible request falls back to chat, and the options are disabled.
    assert await page.eval("document.body.dataset.mode") == "chat"
    states = await page.eval("""Object.fromEntries([...document.querySelectorAll('.login .mode-switch button')]
        .map(b => [b.dataset.mode, {checked: b.getAttribute('aria-checked'), disabled: b.getAttribute('aria-disabled') === 'true'}]))""")
    assert states == {
        "chat": {"checked": "true", "disabled": False},
        "call": {"checked": "false", "disabled": True},
        "both": {"checked": "false", "disabled": True},
    }
    assert "only runs chat" in await page.eval("document.querySelector('.login .mode-hint').textContent")
    assert await page.eval("document.querySelector('.login .mode-hint').hidden") is False
    await page.click(".login .mode-switch [data-mode=call]")  # explains instead of doing nothing
    await page.wait("[...document.querySelectorAll('.toast')].some(t => t.textContent.includes('COMMS_FEATURES'))")
    assert await page.eval("document.body.dataset.mode") == "chat"
    assert not await page.eval(OVERFLOW_JS)
    res = await page.eval(f"({HIT_TEST_JS})('.login .mode-switch [data-mode=chat]')")
    assert res["ok"], res
    await asyncio.sleep(0.2)
    await page.screenshot("phone-320x568-mode-sign-in-chat-server")
