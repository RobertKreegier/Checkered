/* hash.js — canonical serialization and state fingerprints.
 *
 * Two clients must agree on a state's fingerprint even though their
 * objects were built by different code paths in a different order, so
 * keys are sorted before hashing. This is a "did we compute the same
 * thing" check, not a security boundary — a client that wants to lie
 * about its own hash can, and that's out of scope by design.
 */

/** JSON with object keys sorted at every depth, so ordering can't bite. */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

/** FNV-1a over the canonical form, as an 8-char hex string. */
export function hashState(value) {
  const str = canonical(value);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * First differing path between two states, for the desync report. Returns
 * null when they match. Depth-first, reports one difference — enough to
 * point two players at what disagreed without dumping the whole board.
 */
export function firstDifference(a, b, path = '') {
  if (a === b) return null;
  const ta = a === null ? 'null' : typeof a;
  const tb = b === null ? 'null' : typeof b;
  if (ta !== tb) return { path: path || '(root)', mine: a, theirs: b };
  if (ta !== 'object') {
    return a === b ? null : { path: path || '(root)', mine: a, theirs: b };
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return { path: path || '(root)', mine: a, theirs: b };
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const k of keys) {
    const sub = path ? `${path}.${k}` : k;
    if (!(k in a)) return { path: sub, mine: undefined, theirs: b[k] };
    if (!(k in b)) return { path: sub, mine: a[k], theirs: undefined };
    const diff = firstDifference(a[k], b[k], sub);
    if (diff) return diff;
  }
  return null;
}
