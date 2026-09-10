/* saves.js — keeping a game.
 *
 * A save is an action list, not a board.
 *
 * That follows from the invariant the whole engine rests on: a game is
 * (ruleset, config, seed, players, actions). Storing the board instead
 * would be smaller, but it would throw away the record, throw away undo,
 * and — worse — it could drift from what the rules actually produce, with
 * nothing to catch it. An action list cannot lie: replaying it either
 * reproduces the game exactly or fails loudly.
 *
 * It also means a save doubles as a transcript. The same code that
 * restores your game can be handed to someone else to look at.
 *
 * The cost is that a save grows with the length of the game rather than
 * staying a fixed size. In practice this is nothing: a hundred moves of
 * chess is a few kilobytes.
 */

import { Engine } from './engine.js';
import { getRuleset } from '../rulesets/index.js';
import { rulesPin } from './match.js';
import { pack, unpack } from './codec.js';

/** Bumped if the shape of a save ever changes incompatibly. */
export const SAVE_VERSION = 1;

const AUTOSAVE_KEY = 'checkered.autosave';
const SLOT_PREFIX = 'checkered.save.';

/* ============================================================
   MAKING ONE
   ============================================================ */

/**
 * Describe a game completely enough to rebuild it.
 *
 * `seats` and `pin` are carried so a match can be resumed in the right
 * seat and under the right rules — a saved multiplayer game picks up
 * where it left off without needing the other player present.
 */
export function snapshot(engine, { entry, name = null, seats = null, pin = null } = {}) {
  return {
    version: SAVE_VERSION,
    savedAt: new Date().toISOString(),
    name,
    rulesetId: entry?.ruleset?.id || engine.ruleset.id,
    rulesetVersion: entry?.ruleset?.version || engine.ruleset.version,
    rulesetName: entry?.ruleset?.name || engine.ruleset.name,
    config: engine.config,
    seed: engine.seed,
    players: engine.players,
    actions: engine.history.map(h => ({ action: h.action, actorId: h.actorId })),
    seats,
    pin,
  };
}

/** A short line describing a save, for a list of them. */
export function describeSave(save) {
  const when = save.savedAt ? new Date(save.savedAt) : null;
  return {
    id: save.id || null,
    name: save.name || save.rulesetName || save.rulesetId,
    game: save.rulesetName || save.rulesetId,
    moves: (save.actions || []).length,
    players: (save.players || []).map(p => p.name).join(' v '),
    when,
    shared: !!save.seats,
  };
}

/* ============================================================
   BRINGING ONE BACK
   ============================================================ */

/**
 * Rebuild a game from a save.
 *
 * Every failure here is one a person can act on, so each gets its own
 * message rather than a generic "could not load". The rules check
 * matters most: a game played under edited rules and reloaded against
 * the shipped ones will diverge partway through the replay, and without
 * this the error would surface as an incomprehensible mid-game failure.
 */
export function restore(save, { lookup = getRuleset, sourceText = null } = {}) {
  if (!save || typeof save !== 'object') throw new Error('That is not a saved game.');
  if (save.version > SAVE_VERSION) {
    throw new Error('This game was saved by a newer version of Checkered.');
  }

  const entry = lookup(save.rulesetId);
  if (!entry) throw new Error(`You don't have the ruleset "${save.rulesetId}".`);

  if (save.pin) {
    const ourPin = rulesPin(entry, save.config || {}, sourceText);
    if (ourPin !== save.pin) {
      throw new Error(
        'This game was played under different rules than you have now — '
        + 'either the ruleset was edited, or a setting has changed since.',
      );
    }
  }

  let engine;
  try {
    engine = Engine.replay(
      entry.ruleset,
      { config: save.config, seed: save.seed, players: save.players },
      save.actions || [],
    );
  } catch (err) {
    throw new Error(`This game could not be replayed: ${err.message}`);
  }

  return { entry, engine, save };
}

/* ============================================================
   AS A CODE
   ============================================================ */

export const encodeSave = save => pack(save);

export function decodeSave(code) {
  const save = unpack(code, 'saved game');
  if (!save.rulesetId || save.seed === undefined) {
    throw new Error('That code is not a saved game.');
  }
  return save;
}

/** A filename someone will recognise a week later. */
export function saveFilename(save) {
  const stamp = (save.savedAt || '').slice(0, 16).replace(/[:T]/g, '-');
  const game = (save.rulesetId || 'game').replace(/[^a-z0-9]+/gi, '-');
  return `checkered-${game}-${stamp}.txt`;
}

/* ============================================================
   IN THIS BROWSER
   ============================================================ */

/* Storage can be unavailable — private browsing, a blocked origin, a
 * full quota. None of that should break a game in progress, so every
 * call here fails quietly and says so through its return value. */

function readKey(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeKey(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    // Almost always a full quota. The caller decides whether to mention
    // it; a game must not stop because it couldn't be written down.
    return false;
  }
}

function removeKey(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/* ---------- the game in progress ---------- */

/**
 * Keep the current game, so a refresh or a closed tab doesn't lose it.
 * Written on every move; there is only ever one.
 */
export function autosave(save) {
  return writeKey(AUTOSAVE_KEY, save);
}

export function loadAutosave() {
  return readKey(AUTOSAVE_KEY);
}

export function clearAutosave() {
  return removeKey(AUTOSAVE_KEY);
}

/** Is there a game worth offering to resume? */
export function hasResumable() {
  const save = loadAutosave();
  return !!(save && (save.actions || []).length > 0);
}

/* ---------- named saves ---------- */

/** Every saved game in this browser, most recent first. */
export function listSaves() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(SLOT_PREFIX)) continue;
      const save = readKey(key);
      if (save) out.push({ ...save, id: key.slice(SLOT_PREFIX.length) });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
}

/**
 * Keep a game under a name. Returns the id, or null if it couldn't be
 * written — which the caller should mention, since a save the player
 * asked for and didn't get is worth knowing about.
 */
export function saveSlot(save, name) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const named = { ...save, name: name || save.name || save.rulesetName, id };
  return writeKey(SLOT_PREFIX + id, named) ? id : null;
}

export function loadSlot(id) {
  return readKey(SLOT_PREFIX + id);
}

export function deleteSlot(id) {
  return removeKey(SLOT_PREFIX + id);
}

/** Roughly how much room the saves are taking, in bytes. */
export function storageUsed() {
  let total = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('checkered.')) continue;
      total += (localStorage.getItem(key) || '').length;
    }
  } catch {
    return 0;
  }
  return total;
}
