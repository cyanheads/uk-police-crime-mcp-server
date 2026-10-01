/**
 * @fileoverview In-process LRU cache with a TTL counted from insert and a
 * weight budget. Backs every PoliceApiService cache: count-bounded ones weigh
 * each entry 1, the area-response cache weighs entries by heap estimate.
 * @module services/police-api/lru-cache
 */

/** Options for {@link LruCache}. */
export interface LruCacheOptions {
  /** Total weight held. Each entry weighs 1 unless `set` passes a weight. */
  readonly capacity: number;
  /**
   * Heaviest entry accepted. A heavier one is refused — the caller serves it
   * uncached — so one entry can never empty more than this much of the cache.
   * Defaults to `capacity`.
   */
  readonly maxEntryWeight?: number;
  /** Injected clock, epoch milliseconds. */
  readonly now: () => number;
  /** Lifetime from insert. A hit refreshes recency, never the TTL. */
  readonly ttlMs: number;
}

interface Entry<V> {
  readonly expiresAt: number;
  readonly value: V;
  readonly weight: number;
}

/**
 * Least-recently-used cache over a `Map`, whose insertion order doubles as the
 * recency order: a hit re-inserts its entry at the end, eviction walks from the
 * front. On insert, expired entries go first, then the least recently used until
 * the new entry fits.
 */
export class LruCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private totalWeight = 0;

  constructor(private readonly options: LruCacheOptions) {}

  /** Entries currently held, expired ones not yet evicted included. */
  get size(): number {
    return this.entries.size;
  }

  /** Summed weight of the entries held. */
  get weight(): number {
    return this.totalWeight;
  }

  /** The live value for `key`, refreshing its recency; `undefined` when absent or expired. */
  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    if (entry.expiresAt <= this.options.now()) {
      this.totalWeight -= entry.weight;
      return;
    }
    this.entries.set(key, entry);
    return entry.value;
  }

  /**
   * Stores `value` under `key`, evicting as needed. Returns `false` without
   * storing when `weight` exceeds `maxEntryWeight`.
   */
  set(key: string, value: V, weight = 1): boolean {
    const { capacity, maxEntryWeight = capacity, now, ttlMs } = this.options;
    if (weight > maxEntryWeight) return false;
    this.delete(key);
    const at = now();
    for (const [staleKey, entry] of this.entries) {
      if (entry.expiresAt <= at) this.delete(staleKey);
    }
    for (const oldestKey of this.entries.keys()) {
      if (this.totalWeight + weight <= capacity) break;
      this.delete(oldestKey);
    }
    this.entries.set(key, { value, weight, expiresAt: at + ttlMs });
    this.totalWeight += weight;
    return true;
  }

  /** Removes `key` if present. */
  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }
}
