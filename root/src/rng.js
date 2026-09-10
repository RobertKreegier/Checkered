/* rng.js — deterministic randomness.
 *
 * Nothing in a ruleset may call Math.random(). Every random draw goes
 * through here, seeded from a value stored in game state, so that:
 *   - undo/replay reproduces the same board
 *   - two clients replaying the same action list agree byte for byte
 *
 * The generator is mulberry32: small, fast, good enough for shuffling
 * chips around a board. Not cryptographic, and not trying to be.
 */

const MASK = 0xffffffff;

/** Hash an arbitrary string into a 32-bit seed. */
export function seedFromString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * A random source whose entire position is a single integer, so it can be
 * dropped into state and snapshotted like any other field.
 */
export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
  }

  /** Current position — store this, restore with `new Rng(saved)`. */
  get state() {
    return this.seed;
  }

  /** Float in [0, 1). */
  next() {
    this.seed = (this.seed + 0x6d2b79f5) & MASK;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** Integer in [lo, hi], inclusive both ends. */
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }

  /** A uniformly chosen element, or undefined for an empty list. */
  pick(list) {
    return list.length ? list[this.int(list.length)] : undefined;
  }

  /** Fisher-Yates, in place, returns the same array for convenience. */
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
}
