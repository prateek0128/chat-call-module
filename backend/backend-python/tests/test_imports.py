"""Dependency rule: chat, call and moderation import only core; only integration imports several features."""

from __future__ import annotations

import ast
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[1] / "commskit"


def loaded_after(module: str) -> set[str]:
    code = f"import sys, {module}; print('\\n'.join(sorted(sys.modules)))"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    return set(out.stdout.split())


FEATURES = ("commskit.chat", "commskit.call", "commskit.moderation", "commskit.integration")
OPTIONAL_DEPS = ("redis", "httpx", "h2", "cryptography", "boto3", "PIL")


def _without(*allowed: str) -> tuple[str, ...]:
    return tuple(f for f in FEATURES if f not in allowed)


@pytest.mark.parametrize(
    ("module", "forbidden"),
    [
        ("commskit.core", FEATURES + OPTIONAL_DEPS),
        # Devices / push are core, opt-in, and load httpx / cryptography only when a sender is used.
        ("commskit.core.devices", FEATURES + OPTIONAL_DEPS),
        ("commskit.core.push", FEATURES + OPTIONAL_DEPS),
        ("commskit.chat", _without("commskit.chat") + ("redis",)),
        ("commskit.call", _without("commskit.call") + ("redis",)),
        ("commskit.moderation", _without("commskit.moderation") + ("redis",)),
        # integration loads its submodules lazily: link_moderation alone pulls in neither chat nor call.
        ("commskit.integration", ("commskit.chat", "commskit.call", "commskit.moderation")),
    ],
)
def test_runtime_imports(module, forbidden):
    loaded = loaded_after(module)
    leaked = sorted(m for m in loaded if any(m == f or m.startswith(f + ".") for f in forbidden))
    assert not leaked, f"{module} pulled in {leaked}"


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
    return names


@pytest.mark.parametrize(
    ("subpackage", "forbidden"),
    [
        ("core", FEATURES),
        ("chat", _without("commskit.chat")),
        ("call", _without("commskit.call")),
        ("moderation", _without("commskit.moderation")),
    ],
)
def test_static_imports(subpackage, forbidden):
    for path in (PACKAGE / subpackage).glob("*.py"):
        bad = [n for n in _imports(path) if any(n == f or n.startswith(f + ".") for f in forbidden)]
        assert not bad, f"{path.name} imports {bad}"


def test_media_tools_and_s3_are_lazy_and_core_only():
    for module in ("commskit.core.media_tools", "commskit.core.s3"):
        loaded = loaded_after(module)
        leaked = sorted(m for m in loaded if any(m == f or m.startswith(f + ".") for f in FEATURES + OPTIONAL_DEPS))
        assert not leaked, f"{module} pulled in {leaked}"


def test_privacy_helper_imports_no_feature():
    loaded = loaded_after("commskit.integration.privacy")
    assert not [m for m in loaded if m.startswith(("commskit.chat", "commskit.call", "commskit.moderation"))]


def test_link_moderation_in_chat_only_app_does_not_load_call():
    loaded = loaded_after("commskit.chat, commskit.moderation; from commskit.integration import link_moderation as _")
    assert "commskit.call" not in loaded and "commskit.integration.chat_call" not in loaded


def test_redis_bridge_is_optional_and_importable():
    pytest.importorskip("redis")
    from commskit.core.redis_bridge import AWAY_KEY_FMT, PRESENCE_KEY_FMT, USER_CHANNEL_FMT, RedisBridge

    assert (PRESENCE_KEY_FMT, AWAY_KEY_FMT, USER_CHANNEL_FMT) == (
        "presence:{user_id}", "presence_away:{user_id}", "user_channel:{user_id}",
    )
    with pytest.raises(ValueError):
        RedisBridge()
