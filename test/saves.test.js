/* saves.test.js — keeping a game and getting it back.
 *
 * The claim under test is that a save is an exact record, not an
 * approximation: restoring one must land on the identical position,
 * with the identical record behind it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { Engine } from '../src/engine.js';
import { getRuleset } from '../rulesets/index.js';
import { rulesPin, hostMatch } from '../src/match.js';
import {
  snapshot, restore, encodeSave, decodeSave, describeSave, saveFilename,
  autosave, loadAutosave, clearAutosave, hasResumable,
  listSaves, saveSlot, loadSlot, deleteSlot, storageUsed, SAVE_VERSION,
} from '../src/saves.js';

/** A browser-ish environment with working storage. */
function withStorage() {
  const dom = new JSDOM('', { url: 'https://example.test/' });
  global.localStorage = dom.window.localStorage;
  global.localStorage.clear();
  return dom;
}

const OPENINGS = {
  territory: [
    { action: { type: 'place', x: 0, y: 0 }, actorId: 0 },
    { action: { type: 'place', x: 7, y: 2 }, actorId: 1 },
  ],
};

function playedGame(id = 'chess', moves = 6) {
  const entry = getRuleset(id);
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, 2),
    config: id === 'territory' ? { scatterStacks: 2 } : {},
    seed: 21,
  });
  for (const { action, actorId } of OPENINGS[id] || []) eng.applyAction(action, actorId);
  for (let i = 0; i < moves && !eng.isOver(); i++) {
    const actions = eng.legalActions(eng.state.cur);
    if (!actions.length) break;
    eng.applyAction(actions[i % actions.length], eng.state.cur);
  }
  return { entry, eng };
}

/* ---------- the round trip ---------- */

for (const id of ['tictactoe', 'hexapawn', 'chess', 'checkers', 'territory']) {
  test(`${id}: a saved game restores to the identical position`, () => {
    const { entry, eng } = playedGame(id, 5);
    const save = snapshot(eng, { entry });
    const { engine: back } = restore(save);

    assert.equal(back.fingerprint(), eng.fingerprint(),
      `${id}: the restored game is not the same position`);
    assert.equal(back.history.length, eng.history.length,
      'and the record should come back with it');
  });
}

test('a save carries actions, not a board', () => {
  // The whole design: a board could drift from what the rules produce
  // and nothing would catch it. An action list either replays or fails.
  const { entry, eng } = playedGame('chess', 4);
  const save = snapshot(eng, { entry });
  assert.ok(Array.isArray(save.actions));
  assert.equal(save.board, undefined);
  assert.equal(save.state, undefined);
});

test('the record survives, so undo still works after loading', () => {
  const { entry, eng } = playedGame('chess', 4);
  const { engine: back } = restore(snapshot(eng, { entry }));
  assert.ok(back.canUndo(), 'a restored game should still be rewindable');
  back.undo();
  assert.equal(back.history.length, 3);
});

test('a save round-trips as a code', () => {
  const { entry, eng } = playedGame('hexapawn', 3);
  const code = encodeSave(snapshot(eng, { entry }));
  assert.equal(typeof code, 'string');
  const { engine: back } = restore(decodeSave(code));
  assert.equal(back.fingerprint(), eng.fingerprint());
});

test('a damaged code is refused with a readable reason', () => {
  assert.throws(() => decodeSave('this is not a save'), /damaged|readable|not a saved game/i);
  assert.throws(() => decodeSave(encodeSave({ nothing: true })), /not a saved game/);
});

test('a save from a newer version is refused rather than half-read', () => {
  const { entry, eng } = playedGame('chess', 2);
  const save = { ...snapshot(eng, { entry }), version: SAVE_VERSION + 1 };
  assert.throws(() => restore(save), /newer version/);
});

test('a missing ruleset is named', () => {
  const { entry, eng } = playedGame('chess', 2);
  const save = { ...snapshot(eng, { entry }), rulesetId: 'backgammon' };
  assert.throws(() => restore(save), /backgammon/);
});

test('a game saved under edited rules is refused clearly', () => {
  // Without this the replay diverges partway through and surfaces as an
  // incomprehensible mid-game failure.
  const { entry, eng } = playedGame('hexapawn', 2);
  const save = snapshot(eng, { entry, pin: rulesPin(entry, eng.config, 'the edited source') });
  assert.throws(() => restore(save), /different rules/i);
});

test('a save with a matching pin loads', () => {
  const { entry, eng } = playedGame('hexapawn', 2);
  const source = 'the very same source';
  const save = snapshot(eng, { entry, pin: rulesPin(entry, eng.config, source) });
  assert.doesNotThrow(() => restore(save, { sourceText: source }));
});

test('a corrupted action list fails loudly instead of loading a wrong game', () => {
  const { entry, eng } = playedGame('chess', 3);
  const save = snapshot(eng, { entry });
  save.actions[1] = { action: { type: 'move', x: 9, y: 9, tx: 0, ty: 0 }, actorId: 1 };
  assert.throws(() => restore(save), /could not be replayed/);
});

test('settings are saved with the game', () => {
  const entry = getRuleset('tictactoe');
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers, config: { size: 5, inARow: 4 }, seed: 9,
  });
  eng.applyAction(eng.legalActions(0)[0], 0);
  const { engine: back } = restore(snapshot(eng, { entry }));
  assert.equal(back.config.size, 5);
  assert.equal(back.config.inARow, 4, 'a game must come back under the rules it was played by');
});

test('a match can be saved and resumed in the right seat', () => {
  const entry = getRuleset('chess');
  const { match } = hostMatch({ entry, players: entry.defaultPlayers, seed: 3 });
  match.act(match.engine.legalActions(0)[0]);

  const save = snapshot(match.engine, {
    entry, seats: [...match.localSeats], pin: match.pin,
  });
  assert.deepEqual(save.seats, [0], 'which seat is yours has to survive');

  const { engine: back } = restore(save);
  assert.equal(back.fingerprint(), match.engine.fingerprint());
});

/* ---------- describing them ---------- */

test('a save describes itself well enough to pick from a list', () => {
  const { entry, eng } = playedGame('chess', 4);
  const d = describeSave({ ...snapshot(eng, { entry }), id: 'abc' });
  assert.equal(d.game, 'Chess');
  assert.equal(d.moves, 4);
  assert.match(d.players, / v /);
  assert.ok(d.when instanceof Date);
});

test('the filename is recognisable a week later', () => {
  const { entry, eng } = playedGame('chess', 2);
  const name = saveFilename(snapshot(eng, { entry }));
  assert.match(name, /^checkered-chess-/);
  assert.doesNotMatch(name, /[:]/, 'no characters a filesystem will object to');
});

/* ---------- storage ---------- */

test('the game in progress survives a reload', () => {
  withStorage();
  const { entry, eng } = playedGame('chess', 3);
  assert.equal(hasResumable(), false, 'nothing to resume on a fresh browser');

  autosave(snapshot(eng, { entry }));
  assert.equal(hasResumable(), true);

  const { engine: back } = restore(loadAutosave());
  assert.equal(back.fingerprint(), eng.fingerprint());

  clearAutosave();
  assert.equal(hasResumable(), false);
});

test('a game with no moves is not worth resuming', () => {
  withStorage();
  const entry = getRuleset('chess');
  const eng = new Engine(entry.ruleset, { players: entry.defaultPlayers, seed: 1 });
  autosave(snapshot(eng, { entry }));
  assert.equal(hasResumable(), false, 'an untouched board is not a game in progress');
});

test('named saves can be kept, listed, loaded and deleted', () => {
  withStorage();
  const { entry, eng } = playedGame('chess', 3);
  const id = saveSlot(snapshot(eng, { entry }), 'Tuesday game');
  assert.ok(id);

  const all = listSaves();
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'Tuesday game');

  const { engine: back } = restore(loadSlot(id));
  assert.equal(back.fingerprint(), eng.fingerprint());

  deleteSlot(id);
  assert.equal(listSaves().length, 0);
});

test('saves are listed most recent first', () => {
  withStorage();
  const { entry, eng } = playedGame('chess', 2);
  const base = snapshot(eng, { entry });
  saveSlot({ ...base, savedAt: '2026-01-01T00:00:00.000Z' }, 'older');
  saveSlot({ ...base, savedAt: '2026-06-01T00:00:00.000Z' }, 'newer');
  assert.equal(listSaves()[0].name, 'newer');
});

test('the autosave is not mistaken for a named save', () => {
  withStorage();
  const { entry, eng } = playedGame('chess', 2);
  autosave(snapshot(eng, { entry }));
  assert.equal(listSaves().length, 0, 'the game in progress is not a slot');
});

test('storage being unavailable never breaks a game', () => {
  // Private browsing, a blocked origin, a full quota. A save that cannot
  // be written is a disappointment, not a crash.
  const boom = () => { throw new Error('denied'); };
  Object.defineProperty(global, 'localStorage', {
    configurable: true,
    value: { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { return 0; } },
  });

  const { entry, eng } = playedGame('chess', 2);
  assert.doesNotThrow(() => autosave(snapshot(eng, { entry })));
  assert.equal(autosave(snapshot(eng, { entry })), false, 'and it reports the failure');
  assert.equal(loadAutosave(), null);
  assert.deepEqual(listSaves(), []);
  assert.equal(saveSlot(snapshot(eng, { entry }), 'x'), null, 'a refused save says so');
  assert.equal(storageUsed(), 0);
});

test('damaged stored data is ignored rather than thrown', () => {
  const dom = withStorage();
  dom.window.localStorage.setItem('checkered.autosave', '{not json');
  dom.window.localStorage.setItem('checkered.save.broken', 'also not json');
  assert.equal(loadAutosave(), null);
  assert.deepEqual(listSaves(), []);
});

/* ---------- the layer stays generic ---------- */

test('saves name no particular game', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../src/saves.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['chess', 'checkers', 'territory', 'armory', 'pawn']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(code),
      `saves.js mentions "${word}" in code`);
  }
});
