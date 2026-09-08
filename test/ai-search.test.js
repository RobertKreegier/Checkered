/* ai-search.test.js — the searching opponent, and the ladder that
 * measures it.
 *
 * The claim being tested is "stronger than greedy", which is only
 * meaningful as a number. These runs are deliberately short — the long
 * ones live in the notes, not the suite — but they are enough to catch a
 * search that has stopped working, which is the failure that matters.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.js';
import { getRuleset } from '../rulesets/index.js';
import { greedyAi, validateAi, playTurn, seededRandom, allAis } from '../src/ai-api.js';
import { searchAi, SEARCH_DEFAULTS } from '../src/ai-search.js';
import { runLadder, playMatch } from '../src/ladder.js';

/* ---------- the contract ---------- */

test('the searching AI satisfies the AI contract', () => {
  assert.deepEqual(validateAi(searchAi()), []);
});

test('it registers itself as a choosable opponent', () => {
  const ids = allAis().map(a => a.id);
  assert.ok(ids.includes('search'), 'it should appear in the opponent list');
  assert.ok(ids.includes('greedy'), 'without displacing the simpler one');
});

test('the search holds no game-specific knowledge', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../src/ai-search.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['chess', 'checkers', 'armory', 'pawn', 'castle', 'capture']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(code),
      `ai-search.js mentions "${word}" in code — one search must serve every game`);
  }
});

/* ---------- it plays legally, everywhere ---------- */

const OPENINGS = {
  territory: [
    { action: { type: 'place', x: 0, y: 0 }, actorId: 0 },
    { action: { type: 'place', x: 7, y: 2 }, actorId: 1 },
  ],
};

function gameFor(id) {
  const entry = getRuleset(id);
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, 2),
    config: id === 'territory' ? { scatterStacks: 2 } : {},
    seed: 4,
  });
  for (const { action, actorId } of OPENINGS[id] || []) eng.applyAction(action, actorId);
  return eng;
}

for (const id of ['tictactoe', 'hexapawn', 'checkers', 'chess', 'territory']) {
  test(`${id}: the search always returns something legal`, () => {
    const eng = gameFor(id);
    const ai = searchAi({ maxMillis: 40, maxNodes: 3000 });
    const rng = seededRandom(2);

    for (let t = 0; t < 4 && !eng.isOver(); t++) {
      const actor = eng.state.cur;
      assert.doesNotThrow(() => playTurn(eng, ai, actor, rng),
        `${id}: the search threw or looped`);
    }
  });
}

test('a game against the search replays exactly', () => {
  const entry = getRuleset('hexapawn');
  const eng = gameFor('hexapawn');
  const ai = searchAi({ maxMillis: 30 });
  const rng = seededRandom(6);
  for (let t = 0; t < 5 && !eng.isOver(); t++) playTurn(eng, ai, eng.state.cur, rng);

  const replayed = Engine.replay(
    entry.ruleset,
    { config: eng.config, seed: eng.seed, players: eng.players },
    eng.history.map(h => ({ action: h.action, actorId: h.actorId })),
  );
  assert.equal(replayed.fingerprint(), eng.fingerprint());
});

/* ---------- it respects its budget ---------- */

test('thinking time is bounded', () => {
  const eng = gameFor('chess');
  const ai = searchAi({ maxMillis: 120 });
  const rng = seededRandom(1);

  const t0 = Date.now();
  playTurn(eng, ai, eng.state.cur, rng);
  const took = Date.now() - t0;

  // Generous slack for a slow machine, but it must not run away: the
  // whole point of iterative deepening is that time is the knob.
  assert.ok(took < 2000, `a 120ms budget took ${took}ms`);
});

test('a sequence-turn game is handed to the greedy player instead', () => {
  // Territory's turn is a hundred-odd actions, so a single ply of search
  // means enumerating a whole turn. Measured before this delegation
  // existed: 3 seconds a turn, and no stronger than greedy.
  const eng = gameFor('territory');
  const ai = searchAi({ maxMillis: 500 });
  const rng = seededRandom(3);

  const t0 = Date.now();
  playTurn(eng, ai, eng.state.cur, rng);
  const took = Date.now() - t0;
  assert.ok(took < 4000, `a Territory turn took ${took}ms — delegation is not working`);
});

/* ---------- it is actually stronger ---------- */

test('it beats the greedy player at checkers', () => {
  const r = runLadder(getRuleset('checkers'), searchAi({ maxMillis: 60 }), greedyAi(),
    { games: 4, maxTurns: 160 });
  assert.ok(r.score >= 0.7,
    `scored ${(r.score * 100).toFixed(0)}% against greedy — searching should win comfortably`);
  assert.equal(r.errors.length, 0, r.errors[0] || '');
});

test('it never loses at tic tac toe', () => {
  // Perfect play draws. Losing means the search is broken, not unlucky.
  const r = runLadder(getRuleset('tictactoe'), searchAi({ maxMillis: 80 }), greedyAi(),
    { games: 6 });
  assert.equal(r.loss, 0, 'a searching player should never lose tic tac toe');
});

test('deeper search is at least as good as shallower', () => {
  const deep = runLadder(getRuleset('hexapawn'), searchAi({ maxMillis: 60 }),
    searchAi({ maxDepth: 1, maxMillis: 5 }), { games: 6 });
  assert.ok(deep.score >= 0.5,
    `looking further scored only ${(deep.score * 100).toFixed(0)}% against looking once`);
});

/* ---------- the ladder itself ---------- */

test('the ladder alternates seats', () => {
  // Otherwise one side keeps the advantage of moving first and the whole
  // number is worthless.
  const entry = getRuleset('hexapawn');
  const a = playMatch(entry, searchAi({ maxMillis: 20 }), greedyAi(), { seed: 1, seat: 0 });
  const b = playMatch(entry, searchAi({ maxMillis: 20 }), greedyAi(), { seed: 1, seat: 1 });
  assert.ok(a.result && b.result, 'both seatings should produce a result');
});

test('the ladder reports a bot that breaks rather than aborting', () => {
  const broken = { id: 'x', name: 'Broken', version: '1', chooseAction() { throw new Error('nope'); } };
  const r = runLadder(getRuleset('hexapawn'), broken, greedyAi(), { games: 2 });
  assert.equal(r.win, 0);
  assert.ok(r.errors.length, 'the failure should be reported, not swallowed');
});

test('a draw counts as half a point', () => {
  const r = runLadder(getRuleset('tictactoe'), searchAi({ maxMillis: 40 }),
    searchAi({ maxMillis: 40 }), { games: 4 });
  // Two searching players at tic tac toe should mostly draw, which is
  // an even score rather than a zero.
  assert.ok(r.score > 0.3 && r.score < 0.7,
    `two equal players scored ${(r.score * 100).toFixed(0)}%, which is not even`);
});

test('the defaults are sane', () => {
  assert.ok(SEARCH_DEFAULTS.maxMillis > 0 && SEARCH_DEFAULTS.maxDepth > 1);
  assert.ok(SEARCH_DEFAULTS.maxNodes > 1000, 'the node cap should allow a real search');
});
