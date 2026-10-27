"""Push senders: Expo, APNs VoIP (PushKit) and a per-device router (PROTOCOL.md section 8).

``DevicePushRouter`` implements ``PushSender`` (the signature chat and call already use) and
decides per device from ``data["type"]``::

    registry = SqlDeviceRegistry(AsyncSessionLocal)
    push = DevicePushRouter(
        registry,
        expo=ExpoPushSender(access_token=os.getenv("EXPO_ACCESS_TOKEN")),
        voip=ApnsVoipSender.from_env(),          # optional, iOS CallKit
        android_call_style="data",               # or "notification"
    )
    hub = CommsHub(..., push=push)

``httpx`` is needed for Expo (it is in the ``dev`` extra; add it to your app's deps).
APNs needs the ``apns`` extra (``httpx[http2]`` + ``cryptography``); both are imported lazily.
Every sender takes an optional ``client`` (an ``httpx.AsyncClient``) so tests can inject
``httpx.MockTransport``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import OrderedDict
from typing import TYPE_CHECKING, Any, Literal, Mapping, Sequence

from .devices import DeviceInfo, DeviceStore
from .util import callkit_uuid

if TYPE_CHECKING:
    import httpx

logger = logging.getLogger("commskit.push")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts"
APNS_PRODUCTION_HOST = "https://api.push.apple.com"
APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com"

INCOMING_CALL = "incoming_call"

__all__ = [
    "APNS_PRODUCTION_HOST", "APNS_SANDBOX_HOST", "ApnsVoipSender", "DevicePushRouter", "EXPO_PUSH_URL", "EXPO_RECEIPTS_URL",
    "ExpoPushSender", "callkit_uuid",
]


def _httpx() -> Any:
    try:
        import httpx
    except ImportError as exc:  # pragma: no cover - depends on the environment
        raise RuntimeError("commskit push senders need httpx: pip install httpx") from exc
    return httpx


# ---------------------------------------------------------------------- Expo


class ExpoPushSender:
    """Expo push service client. Also a ``PushSender`` on its own (needs ``registry``).

    Tickets with ``DeviceNotRegistered`` remove that token from the registry. Ticket ids of accepted
    messages are remembered (up to ``max_pending_tickets``); ``poll_receipts()`` checks them later
    (``start_receipt_poller(interval=900)`` runs it in the background) and removes tokens whose
    receipt says ``DeviceNotRegistered``.
    """

    def __init__(
        self,
        registry: DeviceStore | None = None,
        *,
        access_token: str | None = None,
        client: "httpx.AsyncClient | None" = None,
        url: str = EXPO_PUSH_URL,
        batch_size: int = 100,
        timeout: float = 10.0,
        sound: str | None = "default",
        receipts_url: str = EXPO_RECEIPTS_URL,
        receipt_batch_size: int = 1000,
        max_pending_tickets: int = 50_000,
        receipt_ttl: float = 24 * 3600,
    ) -> None:
        if not 1 <= batch_size <= 100:
            raise ValueError("Expo accepts at most 100 messages per request")
        if not 1 <= receipt_batch_size <= 1000:
            raise ValueError("Expo accepts at most 1000 receipt ids per request")
        self.registry = registry
        self.access_token = access_token
        self.url = url
        self.batch_size = batch_size
        self.timeout = timeout
        self.sound = sound
        self.receipts_url = receipts_url
        self.receipt_batch_size = receipt_batch_size
        self.max_pending_tickets = max_pending_tickets
        self.receipt_ttl = receipt_ttl
        self._tickets: OrderedDict[str, tuple[str, float]] = OrderedDict()  # ticket id -> (token, sent at)
        self._poller: asyncio.Task[None] | None = None
        self._client = client
        self._owns_client = client is None

    def _get_client(self) -> "httpx.AsyncClient":
        if self._client is None:
            self._client = _httpx().AsyncClient(timeout=self.timeout)
        return self._client

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json", "Accept-Encoding": "gzip, deflate",
                   "Content-Type": "application/json"}
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        return headers

    async def aclose(self) -> None:
        await self.stop_receipt_poller()
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    def build_message(
        self,
        token: str,
        title: str | None,
        body: str | None,
        data: Mapping[str, Any],
        *,
        channel: str | None = "default",
        ttl: int | None = None,
        priority: Literal["default", "normal", "high"] = "high",
        sound: str | None | Literal[False] = False,
        data_only: bool = False,
    ) -> dict[str, Any]:
        """One Expo message. ``data_only`` omits title/body/sound: Android delivers it to the
        app (e.g. to show its own full-screen call UI) instead of displaying it."""
        message: dict[str, Any] = {"to": token, "data": dict(data), "priority": priority}
        if not data_only:
            message["title"] = title
            message["body"] = body
            chosen = self.sound if sound is False else sound
            if chosen:
                message["sound"] = chosen
        else:
            message["_contentAvailable"] = True
        if channel:
            message["channelId"] = channel
        if ttl is not None:
            message["ttl"] = int(ttl)
        return message

    async def send_messages(self, messages: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        """POST in batches of ``batch_size``. Returns one ticket per message (in order);
        a failed batch yields ``{"status": "error", "message": ...}`` tickets."""
        tickets: list[dict[str, Any]] = []
        headers = self._headers()
        client = self._get_client()
        for start in range(0, len(messages), self.batch_size):
            batch = [dict(m) for m in messages[start:start + self.batch_size]]
            batch_tickets: list[dict[str, Any]]
            try:
                response = await client.post(self.url, json=batch, headers=headers)
                body = response.json() if response.content else {}
                if response.status_code >= 400 or body.get("errors"):
                    logger.warning("Expo push batch failed (%s): %s", response.status_code, body.get("errors") or body)
                data = body.get("data") if isinstance(body, dict) else None
                if isinstance(data, list) and len(data) == len(batch):
                    batch_tickets = [t if isinstance(t, dict) else {} for t in data]
                else:
                    error = {"status": "error", "message": f"HTTP {response.status_code}"}
                    batch_tickets = [dict(error) for _ in batch]
            except Exception as exc:
                logger.exception("Expo push request failed")
                batch_tickets = [{"status": "error", "message": str(exc)} for _ in batch]
            await self._handle_tickets(batch, batch_tickets)
            self._remember_tickets(batch, batch_tickets)
            tickets.extend(batch_tickets)
        return tickets

    async def _handle_tickets(self, batch: Sequence[Mapping[str, Any]], tickets: Sequence[Mapping[str, Any]]) -> None:
        for message, ticket in zip(batch, tickets):
            if ticket.get("status") != "error":
                continue
            details = ticket.get("details") or {}
            if details.get("error") == "DeviceNotRegistered":
                token = details.get("expoPushToken") or message.get("to")
                if token and self.registry is not None:
                    try:
                        await self.registry.remove_token(str(token), "expo")
                    except Exception:
                        logger.exception("Removing an unregistered Expo token failed")
            else:
                logger.warning("Expo push error: %s", ticket.get("message") or details)

    def _remember_tickets(self, batch: Sequence[Mapping[str, Any]], tickets: Sequence[Mapping[str, Any]]) -> None:
        now = time.monotonic()
        for message, ticket in zip(batch, tickets):
            ticket_id = ticket.get("id")
            if ticket.get("status") == "ok" and ticket_id and message.get("to"):
                self._tickets[str(ticket_id)] = (str(message["to"]), now)
                self._tickets.move_to_end(str(ticket_id))
        while len(self._tickets) > self.max_pending_tickets:
            self._tickets.popitem(last=False)

    @property
    def pending_tickets(self) -> dict[str, str]:
        """{ticket_id: expo_push_token} still waiting for a receipt."""
        return {tid: token for tid, (token, _) in self._tickets.items()}

    async def poll_receipts(self) -> dict[str, int]:
        """Fetch receipts for the remembered tickets (``getReceipts``, at most 1000 ids per request).

        ``DeviceNotRegistered`` removes the token from the registry. Tickets with a receipt are
        forgotten; tickets without one stay pending until ``receipt_ttl`` (Expo keeps receipts ~24 h).
        Returns counts: ``{"checked", "ok", "errors", "unregistered", "pending"}``."""
        now = time.monotonic()
        for tid in [t for t, (_, at) in self._tickets.items() if now - at > self.receipt_ttl]:
            self._tickets.pop(tid, None)
        ids = list(self._tickets)
        summary = {"checked": len(ids), "ok": 0, "errors": 0, "unregistered": 0, "pending": 0}
        if not ids:
            return summary
        client = self._get_client()
        headers = self._headers()
        receipts: dict[str, Any] = {}
        for start in range(0, len(ids), self.receipt_batch_size):
            chunk = ids[start:start + self.receipt_batch_size]
            try:
                response = await client.post(self.receipts_url, json={"ids": chunk}, headers=headers)
                body = response.json() if response.content else {}
                data = body.get("data") if isinstance(body, dict) else None
                if response.status_code >= 400 or not isinstance(data, dict):
                    logger.warning("Expo getReceipts failed (%s): %s", response.status_code,
                                   (body or {}).get("errors") if isinstance(body, dict) else body)
                    continue
                receipts.update(data)
            except Exception:
                logger.exception("Expo getReceipts request failed")
        for tid in ids:
            receipt = receipts.get(tid)
            if not isinstance(receipt, dict):
                summary["pending"] += 1
                continue
            token, _ = self._tickets.pop(tid, ("", 0.0))
            if receipt.get("status") == "ok":
                summary["ok"] += 1
                continue
            summary["errors"] += 1
            details = receipt.get("details") or {}
            if details.get("error") == "DeviceNotRegistered":
                summary["unregistered"] += 1
                token = details.get("expoPushToken") or token
                if token and self.registry is not None:
                    try:
                        await self.registry.remove_token(str(token), "expo")
                    except Exception:
                        logger.exception("Removing an unregistered Expo token failed")
            else:
                logger.warning("Expo receipt error: %s", receipt.get("message") or details)
        return summary

    def start_receipt_poller(self, interval: float = 900.0) -> "asyncio.Task[None]":
        """Poll receipts every ``interval`` seconds in the background (call inside a running loop,
        e.g. the app lifespan). ``stop_receipt_poller()`` / ``aclose()`` stop it."""
        if self._poller is not None and not self._poller.done():
            return self._poller

        async def loop() -> None:
            while True:
                await asyncio.sleep(interval)
                try:
                    await self.poll_receipts()
                except Exception:
                    logger.exception("Expo receipt polling failed")

        self._poller = asyncio.create_task(loop())
        return self._poller

    async def stop_receipt_poller(self) -> None:
        poller, self._poller = self._poller, None
        if poller is None:
            return
        poller.cancel()
        try:
            await poller
        except (asyncio.CancelledError, Exception):
            pass

    async def send(
        self, user_id: str, title: str, body: str, data: Mapping[str, Any],
        channel: str = "default", ttl: int | None = None,
    ) -> None:
        """``PushSender``: visible notification to every Expo token of ``user_id``."""
        if self.registry is None:
            raise RuntimeError("ExpoPushSender.send needs a registry (or use DevicePushRouter)")
        tokens = [d.expo_push_token for d in await self.registry.devices_for(user_id) if d.expo_push_token]
        if tokens:
            await self.send_messages([self.build_message(t, title, body, data, channel=channel, ttl=ttl) for t in tokens])


# ------------------------------------------------------------- APNs (VoIP)


class ApnsVoipSender:
    """iOS PushKit (VoIP) pushes over HTTP/2 with token-based (.p8) auth.

    Headers: ``apns-push-type: voip``, ``apns-topic: <bundle_id>.voip``, ``apns-priority: 10``,
    ``apns-expiration: now + expiration``. The provider JWT (ES256, ``kid`` = key id,
    ``iss`` = team id) is reused and refreshed every ``token_refresh`` seconds (< 60 min,
    as Apple requires). ``410`` / ``BadDeviceToken`` / ``Unregistered`` remove the token.
    """

    INVALID_TOKEN_REASONS = frozenset({"BadDeviceToken", "Unregistered"})

    def __init__(
        self,
        *,
        key: str | None = None,
        key_path: str | None = None,
        key_id: str,
        team_id: str,
        bundle_id: str,
        use_sandbox: bool = False,
        registry: DeviceStore | None = None,
        client: "httpx.AsyncClient | None" = None,
        expiration: int = 45,
        token_refresh: int = 50 * 60,
        timeout: float = 10.0,
    ) -> None:
        if not (key or key_path):
            raise ValueError("ApnsVoipSender needs key (PEM text of the .p8) or key_path")
        if not (key_id and team_id and bundle_id):
            raise ValueError("ApnsVoipSender needs key_id, team_id and bundle_id")
        if not 0 < token_refresh < 3600:
            raise ValueError("token_refresh must be under 60 minutes")
        if key is None:
            with open(key_path, encoding="utf-8") as fh:  # type: ignore[arg-type]
                key = fh.read()
        self._key = key
        self.key_id = key_id
        self.team_id = team_id
        self.bundle_id = bundle_id
        self.topic = bundle_id if bundle_id.endswith(".voip") else f"{bundle_id}.voip"
        self.host = APNS_SANDBOX_HOST if use_sandbox else APNS_PRODUCTION_HOST
        self.registry = registry
        self.expiration = expiration
        self.token_refresh = token_refresh
        self.timeout = timeout
        self._client = client
        self._owns_client = client is None
        self._jwt: str | None = None
        self._jwt_issued_at = 0.0
        self._check_crypto()

    @classmethod
    def from_env(cls, registry: DeviceStore | None = None, **overrides: Any) -> "ApnsVoipSender | None":
        """Build from ``APNS_KEY`` / ``APNS_KEY_PATH``, ``APNS_KEY_ID``, ``APNS_TEAM_ID``,
        ``APNS_BUNDLE_ID``, ``APNS_USE_SANDBOX`` (1/true). ``None`` when not configured."""
        key, key_path = os.getenv("APNS_KEY"), os.getenv("APNS_KEY_PATH")
        key_id, team_id, bundle = os.getenv("APNS_KEY_ID"), os.getenv("APNS_TEAM_ID"), os.getenv("APNS_BUNDLE_ID")
        if not ((key or key_path) and key_id and team_id and bundle):
            return None
        sandbox = os.getenv("APNS_USE_SANDBOX", "").strip().lower() in ("1", "true", "yes")
        kwargs: dict[str, Any] = dict(key=key.replace("\\n", "\n") if key else None, key_path=key_path,
                                      key_id=key_id, team_id=team_id, bundle_id=bundle, use_sandbox=sandbox,
                                      registry=registry)
        kwargs.update(overrides)
        return cls(**kwargs)

    @staticmethod
    def _check_crypto() -> None:
        try:
            import cryptography  # noqa: F401
            import jwt  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "ApnsVoipSender needs the 'apns' extra: pip install \"commskit[apns]\" "
                "(httpx[http2] + cryptography)"
            ) from exc

    def _get_client(self) -> "httpx.AsyncClient":
        if self._client is None:
            try:
                import h2  # noqa: F401
            except ImportError as exc:
                raise RuntimeError(
                    "APNs requires HTTP/2: pip install \"commskit[apns]\" (httpx[http2])"
                ) from exc
            self._client = _httpx().AsyncClient(http2=True, timeout=self.timeout)
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    def provider_token(self) -> str:
        """Cached ES256 provider JWT; re-signed after ``token_refresh`` seconds."""
        now = time.time()
        if self._jwt is None or now - self._jwt_issued_at >= self.token_refresh:
            import jwt

            issued = int(now)
            self._jwt = jwt.encode({"iss": self.team_id, "iat": issued}, self._key,
                                   algorithm="ES256", headers={"kid": self.key_id})
            self._jwt_issued_at = float(issued)
        return self._jwt

    def headers(self) -> dict[str, str]:
        return {
            "authorization": f"bearer {self.provider_token()}",
            "apns-push-type": "voip",
            "apns-topic": self.topic,
            "apns-priority": "10",
            "apns-expiration": str(int(time.time()) + int(self.expiration)),
        }

    async def send_voip(self, token: str, payload: Mapping[str, Any]) -> bool:
        """POST /3/device/<token>. True when APNs accepted it."""
        client = self._get_client()
        body = json.dumps(dict(payload), separators=(",", ":"))
        url = f"{self.host}/3/device/{token}"
        for attempt in range(2):
            try:
                response = await client.post(url, content=body, headers=self.headers())
            except Exception:
                logger.exception("APNs request failed")
                return False
            if response.status_code == 200:
                return True
            reason = ""
            try:
                reason = str((response.json() or {}).get("reason", ""))
            except ValueError:
                pass
            if response.status_code == 403 and reason == "ExpiredProviderToken" and attempt == 0:
                self._jwt = None  # clock skew or a long-lived process: re-sign once and retry
                continue
            if response.status_code == 410 or reason in self.INVALID_TOKEN_REASONS:
                if self.registry is not None:
                    try:
                        await self.registry.remove_token(token, "voip")
                    except Exception:
                        logger.exception("Removing an invalid VoIP token failed")
            else:
                logger.warning("APNs VoIP push failed: %s %s", response.status_code, reason)
            return False
        return False


# ------------------------------------------------------------------ router


class DevicePushRouter:
    """``PushSender`` that picks the transport per device (PROTOCOL.md section 8).

    - ``data["type"] == "incoming_call"``:
      - iOS device with a ``voip_token`` and a ``voip`` sender -> APNs VoIP push with
        ``uuid = callkit_uuid(call_id)``; if APNs refuses it and the device has an Expo
        token, a visible Expo notification is sent instead.
      - Android and ``android_call_style == "data"`` -> Expo data-only, priority high, ttl.
      - anything else (Android "notification" style, iOS without VoIP token, web) ->
        visible Expo notification, priority high, ttl, channel (e.g. ``call_ringtone``).
    - every other push (chat, missed call, host pushes) -> visible Expo notification.
    """

    def __init__(
        self,
        registry: DeviceStore,
        expo: ExpoPushSender | None = None,
        voip: ApnsVoipSender | None = None,
        android_call_style: Literal["notification", "data"] = "notification",
    ) -> None:
        if android_call_style not in ("notification", "data"):
            raise ValueError("android_call_style must be 'notification' or 'data'")
        self.registry = registry
        self.expo = expo or ExpoPushSender(registry)
        self.voip = voip
        self.android_call_style = android_call_style
        if self.expo.registry is None:
            self.expo.registry = registry
        if self.voip is not None and self.voip.registry is None:
            self.voip.registry = registry

    async def aclose(self) -> None:
        await self.expo.aclose()
        if self.voip is not None:
            await self.voip.aclose()

    async def send(
        self, user_id: str, title: str, body: str, data: Mapping[str, Any],
        channel: str = "default", ttl: int | None = None,
    ) -> None:
        devices = list(await self.registry.devices_for(user_id))
        if not devices:
            return
        is_call = data.get("type") == INCOMING_CALL
        expo_messages: list[dict[str, Any]] = []
        voip_jobs: list[tuple[DeviceInfo, dict[str, Any]]] = []

        def visible(device: DeviceInfo) -> dict[str, Any]:
            return self.expo.build_message(device.expo_push_token, title, body, data,  # type: ignore[arg-type]
                                           channel=channel, ttl=ttl, priority="high")

        for device in devices:
            if not is_call:
                if device.expo_push_token:
                    expo_messages.append(visible(device))
                continue
            if device.platform == "ios" and device.voip_token and self.voip is not None:
                payload = dict(data)
                if data.get("call_id"):
                    payload["uuid"] = callkit_uuid(str(data["call_id"]))
                voip_jobs.append((device, payload))
            elif not device.expo_push_token:
                continue
            elif device.platform == "android" and self.android_call_style == "data":
                expo_messages.append(self.expo.build_message(
                    device.expo_push_token, None, None, data, channel=channel, ttl=ttl,
                    priority="high", data_only=True,
                ))
            else:
                expo_messages.append(visible(device))

        if voip_jobs:
            assert self.voip is not None
            results = await asyncio.gather(*(self.voip.send_voip(d.voip_token, p) for d, p in voip_jobs),  # type: ignore[arg-type]
                                           return_exceptions=True)
            for (device, _), ok in zip(voip_jobs, results):
                if ok is not True and device.expo_push_token:
                    expo_messages.append(visible(device))
        if expo_messages:
            await self.expo.send_messages(expo_messages)
