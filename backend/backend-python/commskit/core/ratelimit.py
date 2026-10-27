"""Per-user rate limits (token bucket), PROTOCOL.md section 9 "Limits".

``RateLimiter`` keeps the buckets in memory (one worker). ``RedisRateLimiter`` shares them
across workers through the ``RedisBridge`` client (or any ``redis.asyncio`` client); it does not
import ``redis`` itself and falls back to an in-memory limiter while Redis is unavailable.

Keys are ``"<action>:<user_id>"``, e.g. ``chat.message:U1``, ``chat.upload:U1``,
``chat.typing:U1``, ``call.initiate:U1``.
"""

from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass
from typing import Any, Protocol

from .util import LRU

logger = logging.getLogger("commskit.ratelimit")


@dataclass(frozen=True)
class RateLimit:
    """``count`` actions per ``seconds`` (bucket capacity = ``count``, refilled evenly)."""

    count: int
    seconds: float

    def __post_init__(self) -> None:
        if self.count < 1 or self.seconds <= 0:
            raise ValueError("RateLimit needs count >= 1 and seconds > 0")

    @property
    def rate(self) -> float:
        return self.count / self.seconds


class Limiter(Protocol):
    async def hit(self, key: str, limit: RateLimit | None, cost: float = 1.0) -> float:
        """Take ``cost`` tokens. Returns 0.0 when allowed, else seconds until it would be."""
        ...


def retry_after_seconds(wait: float) -> int:
    """Whole seconds for the wire (``retry_after``), at least 1."""
    return max(1, math.ceil(wait))


class RateLimiter:
    """In-memory token buckets (single worker). ``limit=None`` always allows."""

    def __init__(self, max_keys: int = 100_000, clock: Any = time.monotonic) -> None:
        self._buckets: LRU[str, tuple[float, float]] = LRU(max_keys)
        self._clock = clock

    async def hit(self, key: str, limit: RateLimit | None, cost: float = 1.0) -> float:
        return self.hit_sync(key, limit, cost)

    def hit_sync(self, key: str, limit: RateLimit | None, cost: float = 1.0) -> float:
        if limit is None:
            return 0.0
        now = self._clock()
        tokens, last = self._buckets.get(key) or (float(limit.count), now)
        tokens = min(float(limit.count), tokens + (now - last) * limit.rate)
        if tokens >= cost:
            self._buckets.put(key, (tokens - cost, now))
            return 0.0
        self._buckets.put(key, (tokens, now))
        return (cost - tokens) / limit.rate

    def reset(self, key: str | None = None) -> None:
        if key is None:
            self._buckets.clear()
        else:
            self._buckets.pop(key)


# KEYS[1] bucket; ARGV: capacity, rate (tokens/s), now (s), cost, ttl (ms). Returns the wait as a string
# (Lua numbers become integers on the way out).
_TOKEN_BUCKET_LUA = """
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local v = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(v[1])
local ts = tonumber(v[2])
if tokens == nil or ts == nil then tokens = cap; ts = now end
if now > ts then tokens = math.min(cap, tokens + (now - ts) * rate) end
local wait = 0
if tokens >= cost then tokens = tokens - cost else wait = (cost - tokens) / rate end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'ts', tostring(math.max(now, ts)))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
return tostring(wait)
"""


class RedisRateLimiter:
    """Token buckets in Redis, shared by all workers.

    ``source`` is a ``RedisBridge`` (its ``client`` is read on every call, so the limiter can be
    built before ``hub.connections.start()``) or a ``redis.asyncio.Redis`` client. Any Redis error,
    or no client yet, falls back to ``fallback`` (in-memory by default).
    """

    def __init__(self, source: Any, prefix: str = "ratelimit:", fallback: RateLimiter | None = None) -> None:
        self._source = source
        self.prefix = prefix
        self.fallback = fallback or RateLimiter()

    def _client(self) -> Any:
        if hasattr(self._source, "eval"):
            return self._source
        return getattr(self._source, "client", None)

    async def hit(self, key: str, limit: RateLimit | None, cost: float = 1.0) -> float:
        if limit is None:
            return 0.0
        client = self._client()
        if client is None:
            return await self.fallback.hit(key, limit, cost)
        ttl_ms = int(limit.seconds * 1000 * 2) + 1000
        try:
            raw = await client.eval(_TOKEN_BUCKET_LUA, 1, self.prefix + key, limit.count, repr(limit.rate),
                                    repr(time.time()), repr(float(cost)), ttl_ms)
            if isinstance(raw, bytes):
                raw = raw.decode()
            return max(0.0, float(raw))
        except Exception as exc:
            logger.warning("Redis rate limit failed (%s); using the in-memory limiter", exc)
            return await self.fallback.hit(key, limit, cost)
