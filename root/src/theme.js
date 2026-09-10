/* theme.js — a player's own CSS.
 *
 * Local to this browser and this player: never serialized into a game,
 * never sent over the wire, never visible to an opponent. Two people can
 * play the same match looking at completely different boards.
 */

export const THEME_KEY = 'checkered.theme.css';

/* The project was called Boardworks until 2026-08-31. Anyone who had
 * written their own CSS by then still has it under the old key, so read
 * it once and move it across rather than silently losing their work. */
const LEGACY_KEY = 'boardworks.theme.css';

let styleEl = null;

/** Inject (or clear) the player's custom CSS. */
export function applyTheme(css) {
  if (typeof document === 'undefined') return;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'player-theme';
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = css || '';
}

export function loadTheme() {
  try {
    const current = localStorage.getItem(THEME_KEY);
    if (current !== null) return current;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) {
      localStorage.setItem(THEME_KEY, legacy);
      localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
    return '';
  } catch {
    return '';               // private browsing, storage disabled, etc.
  }
}

export function saveTheme(css) {
  applyTheme(css);
  try {
    localStorage.setItem(THEME_KEY, css);
  } catch {
    /* styling still applies for this session even if it can't be saved */
  }
}

/**
 * Back to the shipped look. Worth having a button for: a bad rule in
 * hand-written CSS can otherwise leave someone stuck looking at a broken
 * board with no obvious way out.
 */
export function resetTheme() {
  applyTheme('');
  try {
    localStorage.removeItem(THEME_KEY);
  } catch { /* nothing to clean up */ }
}
