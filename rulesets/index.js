/* index.js — the ruleset registry.
 *
 * The one place that knows which games exist. The picker, the settings
 * panel, the AI runner, and the conformance test all read from here, so
 * adding a game is a one-line change and a newly added game is covered
 * by the conformance battery automatically rather than silently untested.
 *
 * A user-authored ruleset pasted into the editor gets registered at
 * runtime through `registerRuleset()` instead of being listed here.
 */

import territory from './territory.js';
import checkers from './checkers.js';
import chess from './chess.js';
import { validateRuleset } from '../src/ruleset-api.js';

/**
 * A seat is {name, colors:{primary, accent}}. The color names are
 * deliberately generic: a ruleset decides what they MEAN (Territory
 * paints unit chips primary and armory accent; chess just needs two
 * sides), and the UI never has to learn any game's vocabulary.
 *
 * Metadata the picker needs before a game is loaded: enough to draw a
 * card and set up a table, without having to instantiate anything.
 *
 * `opening` lists actions required to get from a fresh game to real
 * play. Territory needs its camps placed; chess and checkers start ready.
 * Keeping these as ordinary recorded actions (rather than a setup call)
 * is what lets a game replay exactly — see ARCHITECTURE.md.
 */
const ENTRIES = [
  {
    ruleset: territory,
    // Where the source lives, so the code editor can show the real
    // thing rather than an empty box. Fetched at runtime; a ruleset
    // registered from pasted text has none and shows its own text.
    sourceUrl: new URL('./territory.js', import.meta.url).href,
    blurb: 'Expansion, economy, and war on an endless grid.',
    minPlayers: 1,
    maxPlayers: 4,
    needsPlacement: true,
    defaultPlayers: [
      { name: 'Vermilion', colors: { primary: '#E2574C', accent: '#F2C14E' } },
      { name: 'Cobalt', colors: { primary: '#3E8FD0', accent: '#8FD8E8' } },
      { name: 'Fern', colors: { primary: '#6FBF73', accent: '#D5E86B' } },
      { name: 'Orchid', colors: { primary: '#B06FD0', accent: '#E8A8D8' } },
    ],
  },
  {
    ruleset: checkers,
    sourceUrl: new URL('./checkers.js', import.meta.url).href,
    blurb: 'English draughts. Jumps are compulsory; chains run to the end.',
    minPlayers: 2,
    maxPlayers: 2,
    needsPlacement: false,
    defaultPlayers: [
      { name: 'Red', colors: { primary: '#E2574C', accent: '#F2C14E' } },
      { name: 'Black', colors: { primary: '#2C3A38', accent: '#8FD8E8' } },
    ],
  },
  {
    ruleset: chess,
    sourceUrl: new URL('./chess.js', import.meta.url).href,
    blurb: 'The standard game, castling and en passant included.',
    minPlayers: 2,
    maxPlayers: 2,
    needsPlacement: false,
    defaultPlayers: [
      { name: 'White', colors: { primary: '#E7EDE9', accent: '#C8A24A' } },
      { name: 'Black', colors: { primary: '#2C3A38', accent: '#7A6430' } },
    ],
  },
];

const registry = new Map();

/**
 * Add a ruleset at runtime — used for user-authored games pasted into
 * the editor. Returns the entry, or throws with the contract problems if
 * the ruleset doesn't hold up, so the editor can show a real error
 * rather than failing three moves into a game.
 */
export function registerRuleset(ruleset, meta = {}) {
  const problems = validateRuleset(ruleset);
  if (problems.length) {
    throw new Error('Ruleset does not satisfy the contract:\n  ' + problems.join('\n  '));
  }
  const entry = {
    id: ruleset.id,
    name: ruleset.name,
    version: ruleset.version,
    blurb: meta.blurb || '',
    minPlayers: meta.minPlayers ?? 2,
    maxPlayers: meta.maxPlayers ?? 2,
    needsPlacement: meta.needsPlacement ?? false,
    defaultPlayers: meta.defaultPlayers || [{ name: 'Player 1' }, { name: 'Player 2' }],
    sourceUrl: meta.sourceUrl || null,
    source: meta.source || null,      // set for rulesets pasted in by hand
    custom: meta.custom ?? false,
    ruleset,
  };
  registry.set(entry.id, entry);
  return entry;
}

for (const e of ENTRIES) {
  registerRuleset(e.ruleset, { ...e, custom: false });
}

/** Every registered game, built-in and user-added. */
export function allRulesets() {
  return [...registry.values()];
}

export function getRuleset(id) {
  return registry.get(id) || null;
}

/** Drop a user-added ruleset. Built-ins are not removable. */
export function unregisterRuleset(id) {
  const entry = registry.get(id);
  if (!entry || !entry.custom) return false;
  return registry.delete(id);
}

export { territory, checkers, chess };
export default allRulesets;
