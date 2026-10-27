/**
 * Per-user rate limits (token bucket), PROTOCOL.md section 9 "Limits".
 * Keys are "<action>:<userId>", e.g. chat.message:U1, chat.upload:U1, chat.typing:U1, call.initiate:U1.
 * `RedisRateLimiter` (see `redis.ts`) shares buckets across workers.
 */
import { LRU } from "./util.js";

export class RateLimit {
  constructor(
    public readonly count: number,
    public readonly seconds: number,
  ) {
    if (count < 1 || seconds <= 0) throw new Error("RateLimit needs count >= 1 and seconds > 0");
  }
  get rate(): number {
    return this.count / this.seconds;
  }
}

export interface Limiter {
  /** Take `cost` tokens. Returns 0 when allowed, else seconds until it would be. */
  hit(key: string, limit: RateLimit | null | undefined, cost?: number): Promise<number>;
}

/** Whole seconds for the wire (`retry_after`), at least 1. */
export const retryAfterSeconds = (wait: number): number => Math.max(1, Math.ceil(wait));

export class RateLimiter implements Limiter {
  private buckets: LRU<string, [number, number]>;
  constructor(
    maxKeys = 100_000,
    private clock: () => number = () => performance.now() / 1000,
  ) {
    this.buckets = new LRU(maxKeys);
  }

  async hit(key: string, limit: RateLimit | null | undefined, cost = 1): Promise<number> {
    return this.hitSync(key, limit, cost);
  }

  hitSync(key: string, limit: RateLimit | null | undefined, cost = 1): number {
    if (!limit) return 0;
    const now = this.clock();
    const [prev, last] = this.buckets.get(key) ?? [limit.count, now];
    const tokens = Math.min(limit.count, prev + (now - last) * limit.rate);
    if (tokens >= cost) {
      this.buckets.put(key, [tokens - cost, now]);
      return 0;
    }
    this.buckets.put(key, [tokens, now]);
    return (cost - tokens) / limit.rate;
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.pop(key);
  }
}
