/* theme.js — a player's own CSS.
 *
 * Local to this browser and this player: never serialized into a game,
 * never sent over the wire, never visible to an opponent. Two people can
 * play the same match looking at completely different boards.
 */

export const THEME_KEY = 'boardworks.theme.css';

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
    return localStorage.getItem(THEME_KEY) || '';
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
