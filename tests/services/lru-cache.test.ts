/**
 * @fileoverview LruCache: TTL counted from insert, recency on hit, weight
 * budget, eviction order (expired first, then least recently used), the
 * max-entry-weight refusal and size/weight accounting.
 * @module tests/services/lru-cache.test
 */

import { describe, expect, it } from 'vitest';
import { LruCache, type LruCacheOptions } from '@/services/police-api/lru-cache.js';

function makeCache<V = string>(options: Partial<LruCacheOptions> = {}) {
  const clock = { now: 1_000_000 };
  const cache = new LruCache<V>({
    capacity: 3,
    ttlMs: 1000,
    now: () => clock.now,
    ...options,
  });
  return { cache, clock };
}

describe('LruCache', () => {
  describe('get and set', () => {
    it('returns undefined for a key never stored', () => {
      expect(makeCache().cache.get('missing')).toBeUndefined();
    });

    it('returns a stored value', () => {
      const { cache } = makeCache();
      cache.set('a', 'alpha');
      expect(cache.get('a')).toBe('alpha');
    });

    it('returns the very same object that was stored', () => {
      const { cache } = makeCache<readonly number[]>();
      const records = [1, 2, 3];
      cache.set('a', records);
      expect(cache.get('a')).toBe(records);
    });

    it('stores falsy values as values', () => {
      const { cache } = makeCache<number | string | boolean>();
      cache.set('zero', 0);
      cache.set('empty', '');
      cache.set('no', false);
      expect(cache.get('zero')).toBe(0);
      expect(cache.get('empty')).toBe('');
      expect(cache.get('no')).toBe(false);
    });

    it('replaces the value and restarts the TTL when a key is set again', () => {
      const { cache, clock } = makeCache();
      cache.set('a', 'first');
      clock.now += 900;
      cache.set('a', 'second');
      clock.now += 900;
      expect(cache.get('a')).toBe('second');
      expect(cache.size).toBe(1);
    });
  });

  describe('TTL', () => {
    it('serves an entry until its TTL elapses, and not at the TTL instant', () => {
      const { cache, clock } = makeCache();
      cache.set('a', 'alpha');
      clock.now += 999;
      expect(cache.get('a')).toBe('alpha');
      clock.now += 1;
      expect(cache.get('a')).toBeUndefined();
    });

    it('counts the TTL from insert: a hit never extends it', () => {
      const { cache, clock } = makeCache();
      cache.set('a', 'alpha');
      clock.now += 600;
      expect(cache.get('a')).toBe('alpha');
      clock.now += 400;
      expect(cache.get('a')).toBeUndefined();
    });

    it('drops an expired entry on read and releases its weight', () => {
      const { cache, clock } = makeCache();
      cache.set('a', 'alpha', 2);
      clock.now += 1000;
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
      expect(cache.weight).toBe(0);
    });

    it('applies a TTL of its own to each entry from its own insert time', () => {
      const { cache, clock } = makeCache();
      cache.set('old', 'o');
      clock.now += 600;
      cache.set('new', 'n');
      clock.now += 500;
      expect(cache.get('old')).toBeUndefined();
      expect(cache.get('new')).toBe('n');
    });
  });

  describe('eviction by count (every entry weighs 1)', () => {
    it('evicts the least recently inserted entry when full', () => {
      const { cache } = makeCache();
      for (const key of ['a', 'b', 'c', 'd']) cache.set(key, key);
      expect(cache.get('a')).toBeUndefined();
      expect(['b', 'c', 'd'].map((key) => cache.get(key))).toEqual(['b', 'c', 'd']);
      expect(cache.size).toBe(3);
    });

    it('treats a hit as recent use: the untouched entry goes first', () => {
      const { cache } = makeCache();
      for (const key of ['a', 'b', 'c']) cache.set(key, key);
      cache.get('a');
      cache.set('d', 'd');
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe('a');
      expect(cache.get('c')).toBe('c');
      expect(cache.get('d')).toBe('d');
    });

    it('does not evict anything when an existing key is overwritten at capacity', () => {
      const { cache } = makeCache();
      for (const key of ['a', 'b', 'c']) cache.set(key, key);
      cache.set('b', 'b2');
      expect(cache.size).toBe(3);
      expect(['a', 'b', 'c'].map((key) => cache.get(key))).toEqual(['a', 'b2', 'c']);
    });

    it('holds exactly `capacity` entries of weight 1', () => {
      const { cache } = makeCache({ capacity: 10_000, ttlMs: 86_400_000 });
      for (let i = 0; i < 10_001; i++) cache.set(`k${i}`, 'v');
      expect(cache.size).toBe(10_000);
      expect(cache.get('k0')).toBeUndefined();
      expect(cache.get('k1')).toBe('v');
      expect(cache.get('k10000')).toBe('v');
    });
  });

  describe('weight budget', () => {
    it('sums entry weights', () => {
      const { cache } = makeCache({ capacity: 100 });
      cache.set('a', 'a', 30);
      cache.set('b', 'b', 25.5);
      expect(cache.weight).toBe(55.5);
    });

    it('evicts least-recently-used entries until the new one fits', () => {
      const { cache } = makeCache({ capacity: 100 });
      cache.set('a', 'a', 40);
      cache.set('b', 'b', 40);
      cache.set('c', 'c', 40);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBe('b');
      expect(cache.get('c')).toBe('c');
      expect(cache.weight).toBe(80);
    });

    it('evicts as many entries as the new weight needs', () => {
      const { cache } = makeCache({ capacity: 100 });
      cache.set('a', 'a', 30);
      cache.set('b', 'b', 30);
      cache.set('c', 'c', 30);
      cache.set('big', 'big', 90);
      expect(cache.size).toBe(1);
      expect(cache.get('big')).toBe('big');
      expect(cache.weight).toBe(90);
    });

    it('admits an entry that exactly fills the remaining capacity without evicting', () => {
      const { cache } = makeCache({ capacity: 100 });
      cache.set('a', 'a', 60);
      cache.set('b', 'b', 40);
      expect(cache.get('a')).toBe('a');
      expect(cache.weight).toBe(100);
    });

    it('evicts in recency order, so a refreshed entry outlives an older untouched one', () => {
      const { cache } = makeCache({ capacity: 100 });
      cache.set('a', 'a', 40);
      cache.set('b', 'b', 40);
      cache.get('a');
      cache.set('c', 'c', 40);
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('a')).toBe('a');
    });

    it('subtracts the replaced entry weight when a key is overwritten', () => {
      const { cache } = makeCache({ capacity: 100 });
      cache.set('a', 'a', 70);
      cache.set('a', 'a2', 20);
      expect(cache.weight).toBe(20);
      expect(cache.size).toBe(1);
    });

    it('drops expired entries before evicting live ones', () => {
      const { cache, clock } = makeCache({ capacity: 100 });
      cache.set('stale', 's', 40);
      clock.now += 300;
      cache.set('live', 'l', 40);
      cache.get('stale');
      clock.now += 700;
      // `stale` is expired and `live` is not; `live` is the older-used entry, yet only `stale` goes.
      cache.set('new', 'n', 40);
      expect(cache.get('live')).toBe('l');
      expect(cache.get('new')).toBe('n');
      expect(cache.get('stale')).toBeUndefined();
      expect(cache.weight).toBe(80);
    });

    it('prefers dropping every expired entry over evicting a live one that would fit', () => {
      const { cache, clock } = makeCache({ capacity: 100 });
      cache.set('x1', 'x', 30);
      cache.set('x2', 'x', 30);
      clock.now += 900;
      cache.set('live', 'l', 30);
      clock.now += 200;
      cache.set('new', 'n', 60);
      expect(cache.size).toBe(2);
      expect(cache.get('live')).toBe('l');
    });
  });

  describe('maxEntryWeight', () => {
    it('refuses an entry heavier than the limit, returning false and storing nothing', () => {
      const { cache } = makeCache({ capacity: 100, maxEntryWeight: 50 });
      expect(cache.set('big', 'b', 50.0001)).toBe(false);
      expect(cache.get('big')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('accepts an entry exactly at the limit', () => {
      const { cache } = makeCache({ capacity: 100, maxEntryWeight: 50 });
      expect(cache.set('edge', 'e', 50)).toBe(true);
      expect(cache.get('edge')).toBe('e');
    });

    it('leaves existing entries alone when it refuses one', () => {
      const { cache } = makeCache({ capacity: 100, maxEntryWeight: 50 });
      cache.set('a', 'a', 50);
      cache.set('b', 'b', 50);
      expect(cache.set('huge', 'h', 99)).toBe(false);
      expect(cache.get('a')).toBe('a');
      expect(cache.get('b')).toBe('b');
      expect(cache.weight).toBe(100);
    });

    it('keeps the previous value for a key whose new value is refused', () => {
      const { cache } = makeCache({ capacity: 100, maxEntryWeight: 50 });
      cache.set('a', 'small', 10);
      expect(cache.set('a', 'huge', 80)).toBe(false);
      expect(cache.get('a')).toBe('small');
    });

    it('defaults the limit to the capacity', () => {
      const { cache } = makeCache({ capacity: 100 });
      expect(cache.set('full', 'f', 100)).toBe(true);
      expect(cache.set('over', 'o', 100.5)).toBe(false);
    });
  });

  describe('delete', () => {
    it('removes an entry and its weight', () => {
      const { cache } = makeCache({ capacity: 100 });
      cache.set('a', 'a', 30);
      cache.delete('a');
      expect(cache.get('a')).toBeUndefined();
      expect(cache.weight).toBe(0);
      expect(cache.size).toBe(0);
    });

    it('ignores a key that is not present', () => {
      const { cache } = makeCache();
      cache.set('a', 'a');
      cache.delete('nope');
      expect(cache.size).toBe(1);
      expect(cache.weight).toBe(1);
    });
  });
});
