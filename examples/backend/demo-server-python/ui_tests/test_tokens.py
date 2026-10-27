"""demo.css custom properties must equal design/tokens.json (both themes). No browser needed."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

EXAMPLES = Path(__file__).resolve().parents[1]
TOKENS = json.loads((EXAMPLES.parents[2] / "design" / "tokens.json").read_text(encoding="utf-8"))
CSS = (EXAMPLES / "demo.css").read_text(encoding="utf-8")


def kebab(name: str) -> str:
    return re.sub(r"[A-Z]", lambda m: "-" + m.group(0).lower(), name)


def block(selector_regex: str, css: str = CSS) -> dict[str, str]:
    """Custom properties declared in the first rule whose selector matches."""
    m = re.search(selector_regex + r"\s*\{([^{}]*)\}", css)
    assert m, f"no rule for {selector_regex}"
    return {k: v.strip() for k, v in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", m.group(1))}


def media_block(media_regex: str) -> str:
    m = re.search(r"@media\s*" + media_regex + r"\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}", CSS)
    assert m, f"no @media {media_regex}"
    return m.group(1)


LIGHT = block(r"(?m)^:root")
DARK_SYSTEM = block(r':root:not\(\[data-theme="light"\]\)', media_block(r"\(prefers-color-scheme:\s*dark\)"))
DARK_MANUAL = block(r':root\[data-theme="dark"\]')


def norm(v: str) -> str:
    return re.sub(r"\s+", " ", str(v)).strip().lower()


@pytest.mark.parametrize("theme,declared", [("light", LIGHT), ("dark", DARK_SYSTEM), ("dark", DARK_MANUAL)],
                         ids=["light", "dark-prefers-color-scheme", "dark-manual-toggle"])
def test_color_tokens_match(theme, declared):
    expected = TOKENS["color"][theme]
    missing = [k for k in expected if f"--{kebab(k)}" not in declared]
    assert not missing, f"{theme}: missing {missing}"
    wrong = {k: (declared[f"--{kebab(k)}"], v) for k, v in expected.items() if norm(declared[f"--{kebab(k)}"]) != norm(v)}
    assert not wrong, f"{theme}: css != tokens.json: {wrong}"


def test_both_dark_blocks_are_identical():
    assert DARK_SYSTEM == DARK_MANUAL


def test_scale_tokens_match():
    expected = {
        **{f"--avatar-{i}": c for i, c in enumerate(TOKENS["avatarPalette"])},
        **{f"--radius-{k}": f"{v}px" for k, v in TOKENS["radius"].items()},
        **{f"--space-{k}": f"{v}px" for k, v in TOKENS["space"].items()},
        **{f"--font-size-{k}": f"{v}px" for k, v in TOKENS["font"]["size"].items()},
        **{f"--font-weight-{k}": v for k, v in TOKENS["font"]["weight"].items()},
        "--font-family": TOKENS["font"]["family"],
        "--line-height": str(TOKENS["font"]["lineHeight"]),
        **{f"--shadow-{k}": v["css"] for k, v in TOKENS["shadow"].items()},
        **{f"--motion-{k}": f"{v}ms" for k, v in TOKENS["motion"]["duration"].items()},
        **{f"--ease-{k}": "cubic-bezier({})".format(", ".join(str(x) for x in v)) for k, v in TOKENS["motion"]["easing"].items()},
        "--layout-list-width-min": f"{TOKENS['layout']['listWidthMin']}px",
        "--layout-list-width-max": f"{TOKENS['layout']['listWidthMax']}px",
        "--layout-bubble-max-width-pct": str(TOKENS["layout"]["bubbleMaxWidthPct"]),
        "--layout-breakpoint-tablet": f"{TOKENS['layout']['breakpointTablet']}px",
        "--layout-breakpoint-desktop": f"{TOKENS['layout']['breakpointDesktop']}px",
        "--layout-composer-max-lines": str(TOKENS["layout"]["composerMaxLines"]),
        "--layout-tap-target": f"{TOKENS['layout']['tapTarget']}px",
    }
    wrong = {k: (LIGHT.get(k), v) for k, v in expected.items() if norm(LIGHT.get(k, "<missing>")) != norm(v)}
    assert not wrong, wrong


def test_breakpoints_in_media_queries_match_tokens():
    tablet, desktop = TOKENS["layout"]["breakpointTablet"], TOKENS["layout"]["breakpointDesktop"]
    assert f"@media (min-width: {tablet}px)" in CSS
    assert f"@media (min-width: {desktop}px)" in CSS
    assert f"@media (max-width: {tablet - 1}.98px)" in CSS


def test_no_hardcoded_brand_colours_left():
    """The old demo used a pink accent; nothing Smart-Matrimony-branded may remain."""
    for old in ("#e91e63", "#E91E63", "#25d366", "#128c7e"):
        assert old not in CSS
    page = (EXAMPLES / "demo.html").read_text(encoding="utf-8") + (EXAMPLES / "demo.js").read_text(encoding="utf-8")
    assert "Smart Matrimony" not in page and "#e91e63" not in page.lower()


# ------------------------------------------------------------------ appearance: theme presets + wallpapers

PRESETS = TOKENS["themePresets"]
WALLPAPERS = TOKENS["wallpapers"]


def all_media_blocks(media_regex: str) -> list[str]:
    return re.findall(r"@media\s*" + media_regex + r"\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}", CSS)


def rule(selector: str, css: str = CSS) -> dict[str, str]:
    """Custom properties of the rule whose full selector text is exactly `selector`."""
    m = re.search(r"(?:^|[}\n])\s*" + re.escape(selector) + r"\s*\{([^{}]*)\}", css)
    assert m, f"no rule {selector!r}"
    return {k: v.strip() for k, v in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", m.group(1))}


def preset_dark_system(name: str) -> dict[str, str]:
    sel = f':root:not([data-theme="light"])[data-preset="{name}"], :root:not([data-theme="light"]) [data-preset="{name}"]'
    for body in all_media_blocks(r"\(prefers-color-scheme:\s*dark\)"):
        if sel in body:
            return rule(sel, body)
    raise AssertionError(f"no system-dark rule for preset {name}")


def assert_same(declared: dict[str, str], expected: dict[str, str], what: str) -> None:
    missing = [k for k in expected if f"--{kebab(k)}" not in declared]
    assert not missing, f"{what}: missing {missing}"
    wrong = {k: (declared[f"--{kebab(k)}"], v) for k, v in expected.items() if norm(declared[f"--{kebab(k)}"]) != norm(v)}
    assert not wrong, f"{what}: css != tokens.json: {wrong}"
    extra = set(declared) - {f"--{kebab(k)}" for k in expected}
    assert not extra, f"{what}: a preset may only change the accent family + outgoing bubbles, found {extra}"


@pytest.mark.parametrize("name", PRESETS["order"])
def test_theme_preset_css_matches_tokens(name):
    assert_same(rule(f'[data-preset="{name}"]'), PRESETS["light"][name], f"{name} light")
    assert_same(preset_dark_system(name), PRESETS["dark"][name], f"{name} dark (prefers-color-scheme)")
    manual = f':root[data-theme="dark"][data-preset="{name}"], :root[data-theme="dark"] [data-preset="{name}"]'
    assert_same(rule(manual), PRESETS["dark"][name], f"{name} dark (manual)")


def test_indigo_preset_equals_base_tokens():
    for scheme in ("light", "dark"):
        for k, v in PRESETS[scheme]["indigo"].items():
            assert norm(TOKENS["color"][scheme][k]) == norm(v), (scheme, k)


def test_preset_lists_match_page():
    js = (EXAMPLES / "demo.js").read_text(encoding="utf-8")
    html = (EXAMPLES / "demo.html").read_text(encoding="utf-8")
    order = PRESETS["order"]
    assert f"const PRESETS = {json.dumps(order)};".replace('","', '", "') in js
    for p in order:
        assert f'{p}: "{PRESETS["labels"][p]}"' in js
    assert "|".join(order) in html, "the inline pre-paint script must accept every preset"


def wallpaper_vars(scheme: str) -> dict[str, str]:
    expected = {f"--wp-solid-{i}": c for i, c in enumerate(WALLPAPERS[scheme]["solids"])}
    expected |= {f"--wp-grad-{i}": f"linear-gradient(to bottom right, {a}, {b})" for i, (a, b) in enumerate(WALLPAPERS[scheme]["gradients"])}
    expected["--wp-dim-default"] = str(WALLPAPERS[scheme]["imageDimDefault"])
    expected["--wp-dim-rgb"] = "255, 255, 255" if scheme == "light" else "0, 0, 0"  # white overlay in light, black in dark
    return expected


def wallpaper_blocks() -> dict[str, dict[str, str]]:
    roots = [b for b in (dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body))
                         for body in re.findall(r"(?m)^:root\s*\{([^{}]*)\}", CSS)) if "--wp-solid-0" in b]
    assert len(roots) == 1, "one light :root block with the wallpapers"
    sys_dark = [rule(':root:not([data-theme="light"])', body) for body in all_media_blocks(r"\(prefers-color-scheme:\s*dark\)")
                if '--wp-solid-0' in body]
    manual = [dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body)) for body in re.findall(r':root\[data-theme="dark"\]\s*\{([^{}]*)\}', CSS)]
    manual = [b for b in manual if "--wp-solid-0" in b]
    assert len(sys_dark) == 1 and len(manual) == 1
    return {"light": {k: v.strip() for k, v in roots[0].items()}, "dark-system": sys_dark[0], "dark-manual": {k: v.strip() for k, v in manual[0].items()}}


@pytest.mark.parametrize("which,scheme", [("light", "light"), ("dark-system", "dark"), ("dark-manual", "dark")])
def test_wallpaper_css_matches_tokens(which, scheme):
    declared = wallpaper_blocks()[which]
    expected = wallpaper_vars(scheme)
    wrong = {k: (declared.get(k), v) for k, v in expected.items() if norm(declared.get(k, "<missing>")) != norm(v)}
    assert not wrong, f"{which}: {wrong}"


def test_wallpaper_counts_and_image_limits_match_page():
    js = (EXAMPLES / "demo.js").read_text(encoding="utf-8")
    html = (EXAMPLES / "demo.html").read_text(encoding="utf-8")
    for scheme in ("light", "dark"):
        assert len(WALLPAPERS[scheme]["solids"]) == len(WALLPAPERS["light"]["solids"])
        assert len(WALLPAPERS[scheme]["gradients"]) == len(WALLPAPERS["light"]["gradients"])
    assert f"const WP_SOLIDS = {len(WALLPAPERS['light']['solids'])}, WP_GRADIENTS = {len(WALLPAPERS['light']['gradients'])};" in js
    assert f"IMAGE_DIM_MAX = {WALLPAPERS['imageDimMax']}, IMAGE_MAX_EDGE = {WALLPAPERS['imageMaxEdge']}," in js
    assert f'id="apDim" min="0" max="{WALLPAPERS["imageDimMax"]}"' in html
