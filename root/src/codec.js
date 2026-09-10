/* codec.js — turning objects into text that survives being pasted.
 *
 * Base64url: no padding, and nothing that a chat window, a URL, or a
 * filename will mangle. Shared by the match layer and by saved games,
 * which both need to hand a blob of JSON to a human and get it back
 * intact.
 */

/** Encode text as base64url. Works in a browser and in node. */
export function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const raw = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return raw.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url back to text. */
export function fromBase64(code) {
  const raw = String(code).trim().replace(/-/g, '+').replace(/_/g, '/');
  const binary = typeof atob === 'function'
    ? atob(raw)
    : Buffer.from(raw, 'base64').toString('binary');
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Encode any JSON-able value. */
export const pack = value => toBase64(JSON.stringify(value));

/** Decode one, with a readable error rather than a JSON parse failure. */
export function unpack(code, what = 'code') {
  let text;
  try {
    text = fromBase64(code);
  } catch {
    throw new Error(`That ${what} is not readable — it may have been cut short.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`That ${what} is damaged — some of it is missing or altered.`);
  }
}
