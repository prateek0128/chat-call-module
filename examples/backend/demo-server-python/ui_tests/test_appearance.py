"""Appearance: chat theme presets, wallpapers (solid, gradient, user image with dim), per-chat override,
storage-full fallback, sheet layout, call-only mode. Spec: design/DESIGN_SYSTEM.md → "Appearance"."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from _harness import HIT_TEST_JS, OVERFLOW_JS
from conftest import PNG

TOKENS = json.loads((Path(__file__).resolve().parents[4] / "design" / "tokens.json").read_text(encoding="utf-8"))
PRESETS = TOKENS["themePresets"]
WALL = TOKENS["wallpapers"]
THREAD_READY = "DemoApp.S.thread.loaded && !document.querySelector('#msgList[aria-busy]') && !document.getElementById('thread').hidden"
SHEET_OPEN = "!document.getElementById('appearance').hidden"
SHEET_CLOSED = "document.getElementById('appearance').hidden"
IMAGE_KEY = "commsDemo.appearance.image"

# Records the preset on <html> at the moment demo.js publishes window.DemoApp - before demo.js applies
# anything itself (that happens later, in init()). So a value here was set by the inline <head> script.
PRESET_AT_LOAD = """(() => { let v; Object.defineProperty(window, 'DemoApp', { configurable: true, get() { return v; },
  set(x) { window.__presetAtLoad = document.documentElement.dataset.preset || null; v = x; } }); })();"""


def rgb(hex_: str) -> str:
    h = hex_.lstrip("#")
    return "rgb({}, {}, {})".format(*(int(h[i:i + 2], 16) for i in (0, 2, 4)))


def kebab(name: str) -> str:
    return "".join("-" + c.lower() if c.isupper() else c for c in name)


async def open_chat(browser, srv, me="U1", peer="U2", w=1280, h=800, **kw):
    page = await browser.new_page(w, h, **kw)
    await page.goto(f"{srv.base}/#{me}:{peer}")
    await page.wait(THREAD_READY, what="thread loaded")
    await page.wait("document.getElementById('connState').dataset.state === 'online'", what="online")
    return page


async def reload(page, url: str) -> None:
    """A fresh document (goto to the same URL + hash would only be a same-document navigation)."""
    await page.call("Page.navigate", url="about:blank")
    await page.wait("location.href === 'about:blank'", what="about:blank")
    await page.goto(url)
    await page.wait(THREAD_READY, what="thread loaded after reload")


async def root_var(page, name: str) -> str:
    return (await page.eval(f"getComputedStyle(document.documentElement).getPropertyValue('{name}').trim()")).upper()


async def scroller(page, prop: str) -> str:
    return await page.eval(f"getComputedStyle(document.getElementById('scroller')).{prop}")


async def choose_file(page, selector: str, path: Path) -> None:
    root = (await page.call("DOM.getDocument"))["root"]["nodeId"]
    node = (await page.call("DOM.querySelector", nodeId=root, selector=selector))["nodeId"]
    await page.call("DOM.setFileInputFiles", nodeId=node, files=[str(path)])


async def open_global_sheet(page) -> None:
    await page.click("#appearanceBtn")
    await page.wait(SHEET_OPEN, what="appearance sheet")
    await asyncio.sleep(0.3)


async def open_chat_sheet(page) -> None:
    await page.click("#moreBtn")
    await page.wait("!document.getElementById('chatMenu').hidden", what="overflow menu")
    assert await page.eval("document.getElementById('moreBtn').getAttribute('aria-expanded')") == "true"
    await page.wait("document.activeElement.id === 'menuWallpaper'", what="focus on first menu item")
    await page.click("#menuWallpaper")
    await page.wait(SHEET_OPEN, what="appearance sheet (per chat)")
    await asyncio.sleep(0.3)


async def pick(page, selector: str) -> None:
    await page.eval(f"document.querySelector({json.dumps(selector)}).scrollIntoView({{block: 'nearest'}})")
    await page.click(selector)


async def set_dim(page, value: float) -> None:
    await page.eval(f"(el => {{ el.value = '{value}'; el.dispatchEvent(new Event('input', {{bubbles: true}})); }})(document.getElementById('apDim'))")


# ------------------------------------------------------------------ chat theme presets


async def test_preset_rose_applies_persists_and_has_no_flash(browser, seeded):
    page = await open_chat(browser, seeded, init_script=PRESET_AT_LOAD)
    light, dark = PRESETS["light"], PRESETS["dark"]
    assert await root_var(page, "--accent") == light["indigo"]["accent"]
    await open_global_sheet(page)
    assert await page.eval("document.getElementById('appearance').contains(document.activeElement)"), "focus moves into the sheet"
    names = await page.eval("[...document.querySelectorAll('#apThemes [role=radio]')].map(b => b.getAttribute('aria-label'))")
    assert names == [f"{PRESETS['labels'][p]} theme" for p in PRESETS["order"]]
    assert await page.eval("document.getElementById('apThemes').getAttribute('role')") == "radiogroup"

    await pick(page, "#apThemes [data-preset='rose']")
    assert await page.eval("document.documentElement.dataset.preset") == "rose"
    for key in ("accent", "bubbleOut", "accentSoft", "onAccent", "tickOut"):
        assert await root_var(page, f"--{kebab(key)}") == light["rose"][key], key
    await page.wait(f"getComputedStyle(document.querySelector('#msgList .msg.out .bubble')).backgroundColor === '{rgb(light['rose']['bubbleOut'])}'",
                    what="outgoing bubble in rose")
    assert await page.eval("document.querySelector('#apThemes [data-preset=rose]').getAttribute('aria-checked')") == "true"
    assert json.loads(await page.eval("localStorage.getItem('commsDemo.appearance')"))["preset"] == "rose"

    # arrow keys move the selection inside the radiogroup
    await page.press("ArrowDown")
    assert await page.eval("document.documentElement.dataset.preset") == "emerald"
    assert await page.eval("document.activeElement.dataset.preset") == "emerald"
    await page.press("ArrowUp")
    assert await page.eval("document.documentElement.dataset.preset") == "rose"

    # Escape closes and focus returns to the trigger
    await page.press("Escape")
    await page.wait(SHEET_CLOSED, what="Escape closes the sheet")
    assert await page.eval("document.activeElement.id") == "appearanceBtn"

    # reload: applied before demo.js runs (no flash), values intact
    await reload(page, f"{seeded.base}/#U1:U2")
    assert await page.eval("window.__presetAtLoad") == "rose", "preset must be set by the inline <head> script"
    assert await root_var(page, "--accent") == light["rose"]["accent"]
    assert await root_var(page, "--bubble-out") == light["rose"]["bubbleOut"]

    # dark mode (system) + rose
    await page.emulate_media({"prefers-color-scheme": "dark"})
    for key, value in dark["rose"].items():
        assert await root_var(page, f"--{kebab(key)}") == value, f"dark rose {key}"
    assert await root_var(page, "--background") == TOKENS["color"]["dark"]["background"], "the dark base still applies"
    await page.emulate_media({"prefers-color-scheme": "light"})

    # dark mode (manual, from the sheet's Mode control) + rose; Mode is a separate setting
    await open_global_sheet(page)
    await page.click("#apMode [data-scheme='dark']")
    assert await page.eval("document.documentElement.dataset.theme") == "dark"
    assert await page.eval("localStorage.getItem('commsDemo.theme')") == "dark"
    assert await root_var(page, "--accent") == dark["rose"]["accent"]
    assert await root_var(page, "--bubble-out") == dark["rose"]["bubbleOut"]
    assert await page.eval("document.documentElement.dataset.preset") == "rose"
    meta = await page.eval("[...document.querySelectorAll('meta[name=theme-color]')].map(m => m.content.toUpperCase())")
    assert set(meta) == {TOKENS["color"]["dark"]["surface"]}, meta
    # swatches preview each preset in the current mode
    sw = await page.eval("getComputedStyle(document.querySelector('#apThemes [data-preset=ocean] .sw')).backgroundColor")
    assert sw == rgb(dark["ocean"]["bubbleOut"])
    await asyncio.sleep(0.3)
    await page.screenshot("desktop-1280x800-appearance-dark-rose")
    await page.click("#apMode [data-scheme='auto']")
    assert await page.eval("document.documentElement.dataset.theme") is None
    assert await page.eval("localStorage.getItem('commsDemo.theme')") is None
    await page.click("#apDone")
    await page.wait(SHEET_CLOSED)


async def test_preset_cross_fade_respects_reduced_motion(browser, seeded):
    page = await open_chat(browser, seeded, media={"prefers-reduced-motion": "reduce"})
    await open_global_sheet(page)
    await pick(page, "#apThemes [data-preset='violet']")
    assert await page.eval("document.documentElement.classList.contains('ap-fade')") is False
    assert (await page.eval("getComputedStyle(document.getElementById('appearance')).animationDuration")) == "0s"
    normal = await open_chat(browser, seeded)
    await open_global_sheet(normal)
    await pick(normal, "#apThemes [data-preset='violet']")
    assert await normal.eval("document.documentElement.classList.contains('ap-fade')") is True
    await normal.wait("!document.documentElement.classList.contains('ap-fade')", timeout=2, what="fade class removed")


# ------------------------------------------------------------------ wallpapers


async def test_wallpaper_solid_gradient_image_dim_and_persistence(browser, seeded, tmp_path):
    page = await open_chat(browser, seeded)
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "default"
    assert await scroller(page, "backgroundColor") == rgb(TOKENS["color"]["light"]["wallpaper"])
    await page.screenshot("desktop-1280x800-wallpaper-default-light")
    await open_global_sheet(page)
    assert await page.eval("document.getElementById('apScopeSec').hidden"), "no scope section in global mode"
    tiles = await page.eval("[...document.querySelectorAll('#apWalls [role=radio]')].map(b => b.dataset.kind)")
    assert tiles == ["default"] + ["solid"] * len(WALL["light"]["solids"]) + ["gradient"] * len(WALL["light"]["gradients"])
    assert await page.eval("document.getElementById('apDimSec').hidden"), "dim only for images"

    # solid
    await pick(page, "#apWalls [data-kind='solid'][data-index='2']")
    assert await scroller(page, "backgroundColor") == rgb(WALL["light"]["solids"][2])
    assert await scroller(page, "backgroundImage") == "none"
    assert await page.eval("getComputedStyle(document.getElementById('apPreview')).backgroundColor") == rgb(WALL["light"]["solids"][2]), "live preview"
    await page.press("Escape")
    await page.wait(SHEET_CLOSED)
    await asyncio.sleep(0.2)
    await page.screenshot("desktop-1280x800-wallpaper-solid-light")
    await page.emulate_media({"prefers-color-scheme": "dark"})
    assert await scroller(page, "backgroundColor") == rgb(WALL["dark"]["solids"][2]), "the index maps to the dark solid"
    await page.screenshot("desktop-1280x800-wallpaper-solid-dark")
    await page.emulate_media({"prefers-color-scheme": "light"})

    # gradient
    await open_global_sheet(page)
    await pick(page, "#apWalls [data-kind='gradient'][data-index='1']")
    a, b = WALL["light"]["gradients"][1]
    assert await scroller(page, "backgroundImage") == f"linear-gradient(to right bottom, {rgb(a)}, {rgb(b)})"
    await page.press("Escape")
    await page.wait(SHEET_CLOSED)
    await asyncio.sleep(0.2)
    await page.screenshot("desktop-1280x800-wallpaper-gradient-light")
    await page.emulate_media({"prefers-color-scheme": "dark"})
    a, b = WALL["dark"]["gradients"][1]
    assert await scroller(page, "backgroundImage") == f"linear-gradient(to right bottom, {rgb(a)}, {rgb(b)})"
    await page.screenshot("desktop-1280x800-wallpaper-gradient-dark")
    await page.emulate_media({"prefers-color-scheme": "light"})

    # a non-image file is rejected
    txt = tmp_path / "notes.txt"
    txt.write_text("not an image")
    await open_global_sheet(page)
    await choose_file(page, "#apFile", txt)
    await page.wait("[...document.querySelectorAll('.toast.error')].some(t => t.textContent.includes(\"isn't an image\"))", what="non-image toast")
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "gradient"

    # image: cover, centred, dim overlay (white in light), downscaled JPEG stored separately
    img = tmp_path / "beach.png"
    img.write_bytes(PNG)
    await choose_file(page, "#apFile", img)
    await page.wait("document.getElementById('scroller').dataset.wp === 'image'", what="image wallpaper")
    bg = await scroller(page, "backgroundImage")
    assert "data:image/jpeg" in bg, bg[:120]
    assert await scroller(page, "backgroundSize") == "cover, cover"  # dim layer + image
    assert await scroller(page, "backgroundPosition") == "50% 50%, 50% 50%"
    assert bg.startswith(f"linear-gradient(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0))"), "light default dim is 0"
    stored = await page.eval(f"localStorage.getItem('{IMAGE_KEY}')")
    assert stored.startswith("data:image/jpeg;base64,")
    assert "data:" not in await page.eval("localStorage.getItem('commsDemo.appearance')"), "the image lives under its own key"
    assert await page.eval("!!document.querySelector('#apWalls [data-kind=image][aria-checked=true]')"), "custom image tile selected"
    assert not await page.eval("document.getElementById('apDimSec').hidden"), "dim slider shown for images"
    assert await page.eval("document.getElementById('apDim').max") == str(WALL["imageDimMax"])

    await set_dim(page, 0.5)
    assert await page.eval("document.getElementById('scroller').style.getPropertyValue('--wp-dim')") == "0.5"
    assert (await scroller(page, "backgroundImage")).startswith("linear-gradient(rgba(255, 255, 255, 0.5), rgba(255, 255, 255, 0.5))")
    assert await page.eval("document.getElementById('apDimOut').textContent") == "50%"
    await asyncio.sleep(0.2)
    await page.screenshot("desktop-1280x800-appearance-sheet-image-light")
    await page.press("Escape")
    await page.wait(SHEET_CLOSED)
    await asyncio.sleep(0.2)
    await page.screenshot("desktop-1280x800-wallpaper-image-dim50-light")

    # persists after reload
    await reload(page, f"{seeded.base}/#U1:U2")
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "image"
    assert (await scroller(page, "backgroundImage")).startswith("linear-gradient(rgba(255, 255, 255, 0.5)")
    # dark mode: black overlay
    await page.emulate_media({"prefers-color-scheme": "dark"})
    assert (await scroller(page, "backgroundImage")).startswith("linear-gradient(rgba(0, 0, 0, 0.5)")
    await asyncio.sleep(0.2)
    await page.screenshot("desktop-1280x800-wallpaper-image-dim50-dark")
    await page.emulate_media({"prefers-color-scheme": "light"})


async def test_dark_image_dim_default_and_downscale(browser, seeded, tmp_path):
    from _harness import make_png
    big = tmp_path / "big.png"
    big.write_bytes(make_png(2400, 600))
    page = await open_chat(browser, seeded, media={"prefers-color-scheme": "dark"})
    await open_global_sheet(page)
    await choose_file(page, "#apFile", big)
    await page.wait("document.getElementById('scroller').dataset.wp === 'image'", what="image wallpaper")
    size = await page.eval(f"""new Promise(r => {{ const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]);
        i.src = localStorage.getItem('{IMAGE_KEY}'); }})""")
    assert size == [WALL["imageMaxEdge"], 400], size
    dflt = WALL["dark"]["imageDimDefault"]
    assert (await scroller(page, "backgroundImage")).startswith(f"linear-gradient(rgba(0, 0, 0, {dflt})"), "dark default dim"
    assert float(await page.eval("document.getElementById('apDim').value")) == dflt
    await asyncio.sleep(0.2)
    await page.screenshot("desktop-1280x800-appearance-sheet-image-dark")


async def test_per_chat_override_and_reset(browser, seeded):
    page = await open_chat(browser, seeded, w=390, h=844)
    await open_chat_sheet(page)
    assert not await page.eval("document.getElementById('apScopeSec').hidden")
    assert await page.eval("document.querySelector('#apScope [data-scope=chat]').getAttribute('aria-checked')") == "true", "defaults to This chat"
    assert await page.eval("document.getElementById('apReset').disabled"), "nothing to reset yet"
    await pick(page, "#apWalls [data-kind='gradient'][data-index='0']")
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "gradient"
    assert not await page.eval("document.getElementById('apReset').disabled")
    saved = json.loads(await page.eval("localStorage.getItem('commsDemo.appearance')"))
    assert saved["chats"]["U2"] == {"kind": "gradient", "index": 0}
    assert saved["wallpaper"] == {"kind": "default"}
    await page.press("Escape")
    await page.wait(SHEET_CLOSED)
    await page.wait("document.activeElement.id === 'moreBtn'", what="focus back on the overflow button")
    await asyncio.sleep(0.2)
    await page.screenshot("phone-390x844-wallpaper-gradient-light")

    # another chat keeps the default
    await page.click("#backBtn")
    await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await asyncio.sleep(0.3)
    await page.click(".convo[data-id='U3']")
    await page.wait(THREAD_READY)
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "default"
    await page.click("#backBtn")
    await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await asyncio.sleep(0.3)
    await page.click(".convo[data-id='U2']")
    await page.wait(THREAD_READY)
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "gradient"

    # Reset this chat removes the override
    await open_chat_sheet(page)
    await pick(page, "#apReset")
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "default"
    assert "U2" not in json.loads(await page.eval("localStorage.getItem('commsDemo.appearance')"))["chats"]
    assert await page.eval("document.getElementById('apReset').disabled")

    # "All chats" sets the global default (and this chat follows it)
    await pick(page, "#apScope [data-scope='all']")
    await pick(page, "#apWalls [data-kind='solid'][data-index='4']")
    saved = json.loads(await page.eval("localStorage.getItem('commsDemo.appearance')"))
    assert saved["wallpaper"] == {"kind": "solid", "index": 4} and saved["chats"] == {}
    await page.click("#apDone")
    await page.wait(SHEET_CLOSED)
    await page.click("#backBtn")
    await page.wait("document.getElementById('app').dataset.pane === 'list'")
    await asyncio.sleep(0.3)
    await page.click(".convo[data-id='U3']")
    await page.wait(THREAD_READY)
    assert await scroller(page, "backgroundColor") == rgb(WALL["light"]["solids"][4])


async def test_overflow_menu_keyboard(browser, seeded):
    page = await open_chat(browser, seeded)
    await page.click("#moreBtn")
    await page.wait("document.activeElement.id === 'menuWallpaper'")
    assert await page.eval("document.getElementById('chatMenuList').getAttribute('role')") == "menu"
    await page.press("ArrowDown")
    assert await page.eval("document.activeElement.id") == "menuAppearance"
    await page.press("ArrowDown")
    assert await page.eval("document.activeElement.id") == "menuWallpaper"
    await page.press("Escape")
    await page.wait("document.getElementById('chatMenu').hidden")
    assert await page.eval("document.activeElement.id") == "moreBtn"
    assert await page.eval("document.getElementById('moreBtn').getAttribute('aria-expanded')") == "false"
    # Enter on "Appearance" opens the sheet in global mode
    await page.click("#moreBtn")
    await page.wait("document.activeElement.id === 'menuWallpaper'")
    await page.press("ArrowDown")
    await page.press("Enter")
    await page.wait(SHEET_OPEN)
    assert await page.eval("document.getElementById('apScopeSec').hidden")
    # focus is trapped in the sheet
    for _ in range(25):
        await page.press("Tab")
        assert await page.eval("document.getElementById('appearance').contains(document.activeElement)")
    # a click on the backdrop closes it
    await page.eval("document.getElementById('appearance').dispatchEvent(new MouseEvent('click', {bubbles: true}))")
    await page.wait(SHEET_CLOSED)


async def test_image_save_fails_when_storage_is_full(browser, seeded, tmp_path):
    page = await open_chat(browser, seeded)
    await page.eval(f"""(() => {{ const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {{
          if (k === '{IMAGE_KEY}') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          return real.call(this, k, v); }}; }})()""")
    img = tmp_path / "pic.png"
    img.write_bytes(PNG)
    await open_global_sheet(page)
    await choose_file(page, "#apFile", img)
    await page.wait("[...document.querySelectorAll('.toast')].some(t => t.textContent.includes(\"Couldn't save the image on this device; it will reset when you reload.\"))",
                    what="storage-full toast")
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "image", "applied for this session anyway"
    assert "data:image/jpeg" in await scroller(page, "backgroundImage")
    assert await page.eval(f"localStorage.getItem('{IMAGE_KEY}')") is None
    await asyncio.sleep(0.2)
    await page.screenshot("desktop-1280x800-appearance-storage-full-toast")
    # after a reload the image is gone and the chat falls back to the default wallpaper
    await reload(page, f"{seeded.base}/#U1:U2")
    assert await page.eval("document.getElementById('scroller').dataset.wp") == "default"


# ------------------------------------------------------------------ layout


@pytest.mark.parametrize("w,h", [(320, 568), (390, 844), (844, 390), (1280, 800)], ids=lambda v: str(v))
@pytest.mark.parametrize("scheme", ["light", "dark"])
async def test_sheet_layout(browser, seeded, tmp_path, w, h, scheme):
    page = await open_chat(browser, seeded, w=w, h=h, media={"prefers-color-scheme": scheme})
    await asyncio.sleep(0.4)
    keys = ["#chatPane .chat-bar", "#moreBtn", "#callBtn", "#sendBtn"] + (["#backBtn"] if w < 700 else [])
    assert not await page.eval(OVERFLOW_JS)
    for sel in keys:
        res = await page.eval(f"({HIT_TEST_JS})({json.dumps(sel)})")
        assert res["ok"], res
    img = tmp_path / "wall.png"
    img.write_bytes(PNG)
    await open_chat_sheet(page)
    await choose_file(page, "#apFile", img)
    await page.wait("document.getElementById('scroller').dataset.wp === 'image' && !document.getElementById('apDimSec').hidden")
    await page.eval("document.querySelector('.ap-body').scrollTop = 0")
    await asyncio.sleep(0.3)
    kind = "phone" if (w < 700 or h < 500) else "desktop"
    await page.screenshot(f"{kind}-{w}x{h}-appearance-sheet-{scheme}")
    overflow = await page.eval(OVERFLOW_JS)
    assert not overflow, f"horizontal overflow at {w}x{h}: {overflow}"
    panel = await page.rect(".ap-panel")
    assert panel["x"] >= 0 and panel["y"] >= 0 and panel["x"] + panel["w"] <= w + 0.5 and panel["y"] + panel["h"] <= h + 0.5, panel
    if w >= 700:
        assert abs((panel["x"] + panel["w"] / 2) - w / 2) < 2, "centred dialog on tablet/desktop"
    else:
        assert abs(panel["y"] + panel["h"] - h) < 1, "bottom sheet on phones"
    # every control reachable (the body scrolls; go top to bottom)
    for sel in ["#apDone", "#apMode [data-scheme='dark']", "#apThemes [data-preset='graphite']", "#apThemes [data-preset='indigo']",
                "#apWalls [data-kind='default']", "#apWalls [data-kind='gradient'][data-index='4']", "#apChoose",
                "#apWalls [data-kind='image']", "#apDim", "#apScope [data-scope='all']", "#apReset"]:
        await page.eval(f"document.querySelector({json.dumps(sel)}).scrollIntoView({{block: 'nearest'}})")
        await asyncio.sleep(0.05)
        res = await page.eval(f"({HIT_TEST_JS})({json.dumps(sel)})")
        assert res["ok"], f"{sel} at {w}x{h}: {res}"
    await page.eval("document.querySelector('.ap-body').scrollTop = 1e6")
    await asyncio.sleep(0.2)
    await page.screenshot(f"{kind}-{w}x{h}-appearance-sheet-{scheme}-scrolled")
    await page.press("Escape")
    await page.wait(SHEET_CLOSED)
    await asyncio.sleep(0.2)
    await page.screenshot(f"{kind}-{w}x{h}-wallpaper-image-{scheme}")


# ------------------------------------------------------------------ call-only mode


@pytest.mark.parametrize("w,h", [(390, 844), (1280, 800)])
async def test_call_only_has_theme_and_mode_but_no_wallpaper(browser, servers, w, h):
    srv = servers("call")
    page = await browser.new_page(w, h)
    await page.goto(f"{srv.base}/#U1")
    await page.wait("document.querySelectorAll('#convoList .convo:not(.skeleton)').length === 2")
    await asyncio.sleep(0.3)
    await open_global_sheet(page)
    for sec in ("apWallSec", "apDimSec", "apScopeSec"):
        assert await page.eval(f"document.getElementById('{sec}').hidden"), f"{sec} must be hidden in call-only mode"
    assert await page.eval("document.querySelectorAll('#apThemes [role=radio]').length") == 7
    assert await page.eval("document.querySelectorAll('#apMode [role=radio]').length") == 3
    assert not await page.eval(OVERFLOW_JS)
    await page.screenshot(f"{'phone' if w < 700 else 'desktop'}-{w}x{h}-call-only-appearance")
    await pick(page, "#apThemes [data-preset='amber']")
    assert await root_var(page, "--accent") == PRESETS["light"]["amber"]["accent"]
    await page.press("Escape")
    await page.wait(SHEET_CLOSED)
    # the chat header menu offers Appearance only
    if w < 700:
        await asyncio.sleep(0.3)
    await page.click(".convo[data-id='U2']")
    await page.wait("!document.getElementById('callsOnly').hidden")
    await asyncio.sleep(0.4)
    await page.click("#moreBtn")
    await page.wait("!document.getElementById('chatMenu').hidden")
    assert await page.eval("document.getElementById('menuWallpaper').hidden")
    await page.wait("document.activeElement.id === 'menuAppearance'")
    await page.press("Enter")
    await page.wait(SHEET_OPEN)
    assert await page.eval("document.getElementById('apWallSec').hidden")
