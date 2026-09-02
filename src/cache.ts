export type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

export class MemoryCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  get<T>(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.store.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }

  get size(): number {
    this.prune();
    return this.store.size;
  }

  async getOrSet<T>(
    key: string,
    ttlMs: number,
    factory: () => Promise<T>,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = factory()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  private prune(): void {
    const ts = this.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= ts) this.store.delete(key);
    }
  }
}

export function cacheKey(parts: Array<string | number | undefined | null>): string {
  return parts.map((part) => (part == null ? "" : String(part))).join("|");
}
