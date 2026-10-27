"""Devices: POST /devices, DELETE /devices/{id}, legacy /chats/expo/push/token routes."""

from __future__ import annotations

import pytest

from commskit.core.devices import SqlDeviceRegistry

from conftest import auth_headers


def devices_of(env, user_id):
    return env.client.portal.call(env.devices.registry.devices_for, user_id)


IOS = {"device_id": "dev-ios-1", "platform": "ios", "expo_push_token": "ExponentPushToken[ios1]",
       "voip_token": "voip-ios-1", "app_version": "1.0.0", "os_version": "17.4", "model": "iPhone15,2"}


@pytest.mark.parametrize("mode", [dict(chat=True, call=True), dict(chat=True, call=False), dict(chat=False, call=True)])
def test_register_upsert_and_delete(make_env, mode):
    env = make_env(devices=True, **mode)
    r = env.client.post("/devices", json=IOS, headers=auth_headers("A"))
    assert r.status_code == 200 and r.json() == {"status": True}
    [dev] = devices_of(env, "A")
    assert (dev.platform, dev.expo_push_token, dev.voip_token, dev.model) == ("ios", "ExponentPushToken[ios1]", "voip-ios-1", "iPhone15,2")

    # Upsert by device_id: fields sent are updated, fields omitted are kept.
    r = env.client.post("/devices", json={"device_id": "dev-ios-1", "platform": "ios", "app_version": "1.1.0"},
                        headers=auth_headers("A"))
    assert r.status_code == 200
    [dev] = devices_of(env, "A")
    assert dev.app_version == "1.1.0" and dev.voip_token == "voip-ios-1"

    # Someone else's DELETE does nothing; the owner's removes it (and is idempotent).
    assert env.client.delete("/devices/dev-ios-1", headers=auth_headers("B")).json() == {"status": True}
    assert len(devices_of(env, "A")) == 1
    assert env.client.delete("/devices/dev-ios-1", headers=auth_headers("A")).json() == {"status": True}
    assert devices_of(env, "A") == []
    assert env.client.delete("/devices/dev-ios-1", headers=auth_headers("A")).status_code == 200


def test_validation_and_auth(make_env):
    env = make_env(devices=True)
    assert env.client.post("/devices", json=IOS).status_code == 401
    assert env.client.post("/devices", json={"platform": "ios"}, headers=auth_headers("A")).status_code == 422
    bad = {**IOS, "platform": "symbian"}
    assert env.client.post("/devices", json=bad, headers=auth_headers("A")).status_code == 422


def test_device_changes_hands_and_tokens_are_unique(make_env):
    env = make_env(devices=True)
    env.client.post("/devices", json=IOS, headers=auth_headers("A"))
    # B logs in on the same phone without sending a VoIP token: A's tokens must not follow.
    env.client.post("/devices", json={"device_id": "dev-ios-1", "platform": "ios",
                                      "expo_push_token": "ExponentPushToken[ios1]"}, headers=auth_headers("B"))
    assert devices_of(env, "A") == []
    [dev] = devices_of(env, "B")
    assert dev.voip_token is None and dev.expo_push_token == "ExponentPushToken[ios1]"

    # Same Expo token reported by a new install id: the old row loses it.
    env.client.post("/devices", json={"device_id": "dev-ios-2", "platform": "ios",
                                      "expo_push_token": "ExponentPushToken[ios1]"}, headers=auth_headers("B"))
    tokens = {d.device_id: d.expo_push_token for d in devices_of(env, "B")}
    assert tokens == {"dev-ios-1": None, "dev-ios-2": "ExponentPushToken[ios1]"}


@pytest.mark.parametrize("mode", [dict(chat=True, call=False), dict(chat=False, call=True), dict(chat=True, call=True)])
def test_legacy_routes_map_onto_registry(make_env, mode):
    env = make_env(devices=True, **mode)
    h = auth_headers("A")
    r = env.client.post("/chats/expo/push/token", json={"expo_push_token": "ExponentPushToken[legacy]",
                                                        "device_type": "android"}, headers=h)
    assert r.status_code == 200 and r.json()["status"] is True
    [dev] = devices_of(env, "A")
    assert dev.device_id == "expo:ExponentPushToken[legacy]" and dev.platform == "android"

    r = env.client.post("/chats/expo/push/token/remove", json={"expo_push_token": "ExponentPushToken[legacy]"}, headers=h)
    assert r.status_code == 200 and r.json() == {"status": True, "removed": True}
    assert devices_of(env, "A") == []
    assert env.client.post("/chats/expo/push/token/remove", json={}, headers=h).status_code == 422

    # Legacy body with a device id and no platform.
    env.client.post("/chats/expo/push/token", json={"token": "ExponentPushToken[x]", "device_id": "d1"}, headers=h)
    [dev] = devices_of(env, "A")
    assert dev.device_id == "d1" and dev.platform == "unknown"
    env.client.post("/chats/expo/push/token/remove", json={"device_id": "d1"}, headers=h)
    assert devices_of(env, "A") == []


def test_chat_feature_devices_argument_still_mounts_legacy_routes(make_env):
    env = make_env(chat=True, call=False, chat_devices=SqlDeviceRegistry)
    r = env.client.post("/chats/expo/push/token", json={"expo_push_token": "ExponentPushToken[c]"},
                        headers=auth_headers("A"))
    assert r.status_code == 200
    registry = env.chat.devices
    [dev] = env.client.portal.call(registry.devices_for, "A")
    assert dev.expo_push_token == "ExponentPushToken[c]"
    # /devices is DevicesFeature's, not mounted here.
    assert env.client.post("/devices", json=IOS, headers=auth_headers("A")).status_code in (404, 405)


def test_remove_token(make_env):
    env = make_env(devices=True)
    env.client.post("/devices", json=IOS, headers=auth_headers("A"))
    registry = env.devices.registry
    assert env.client.portal.call(registry.remove_token, "voip-ios-1", "voip") == 1
    [dev] = devices_of(env, "A")
    assert dev.voip_token is None and dev.expo_push_token == "ExponentPushToken[ios1]"
    assert env.client.portal.call(registry.remove_token, "ExponentPushToken[ios1]") == 1
    assert devices_of(env, "A")[0].expo_push_token is None
