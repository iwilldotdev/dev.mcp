import { MemoryCache, cacheKey } from "../src/cache.js";

describe("MemoryCache", () => {
  it("returns the cached value within TTL", async () => {
    const cache = new MemoryCache(() => 1_000);
    let calls = 0;
    const first = await cache.getOrSet("k", 5_000, async () => {
      calls += 1;
      return "a";
    });
    const second = await cache.getOrSet("k", 5_000, async () => {
      calls += 1;
      return "b";
    });
    expect(first).toBe("a");
    expect(second).toBe("a");
    expect(calls).toBe(1);
  });

  it("deduplicates concurrent calls for the same key", async () => {
    const cache = new MemoryCache();
    let calls = 0;
    const factory = () =>
      new Promise<number>((resolve) => {
        calls += 1;
        setTimeout(() => resolve(calls), 25);
      });
    const [a, b] = await Promise.all([
      cache.getOrSet("dup", 10_000, factory),
      cache.getOrSet("dup", 10_000, factory),
    ]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(calls).toBe(1);
  });

  it("expires the entry when TTL elapses", async () => {
    let now = 0;
    const cache = new MemoryCache(() => now);
    await cache.getOrSet("k", 10, async () => 1);
    now = 11;
    const next = await cache.getOrSet("k", 10, async () => 2);
    expect(next).toBe(2);
  });

  it("does not persist when ttl is 0", () => {
    const cache = new MemoryCache();
    cache.set("k", 1, 0);
    expect(cache.get("k")).toBeUndefined();
  });

  it("builds stable keys", () => {
    expect(cacheKey(["figma", "file", "abc"])).toBe("figma|file|abc");
  });
});
