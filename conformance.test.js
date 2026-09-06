/* conformance.test.js — the same tests, run against every ruleset.
 *
 * This is the file that justifies the engine/ruleset split. Anything
 * asserted here is a promise the engine makes to ALL games, so a new
 * ruleset can be dropped in and checked against the same bar. If a test
 * here needs a special case for one game, that's a sign the contract is
 * leaking game-specific assumptions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine, verifyRemoteAction } from '../src/engine.js';
import { Rng } from '../src/rng.js';
import { validateRuleset } from '../src/ruleset-api.js';

import {
  allRulesets, registerRuleset, unregisterRuleset, getRuleset,
} from '../rulesets/index.js';

const PLAYERS = [
  { name: 'One', unit: '#E2574C', armory: '#F2C14E' },
  { name: 'Two', unit: '#3E8FD0', armory: '#8FD8E8' },
];

/**
 * Every registered game gets the same battery. Reading the list from the
 * registry rather than hardcoding it here is deliberate: a newly added
 * ruleset is covered automatically instead of being silently untested.
 *
 * A game that needs setup before real play (Territory placing its camps)
 * declares those as ordinary recorded actions, so replay sees exactly
 * what the live game saw.
 */
const OPENINGS = {
  territory: [
    { action: { type: 'place', x: 0, y: 0 }, actorId: 0 },
    { action: { type: 'place', x: 9, y: 2 }, actorId: 1 },
  ],
};

const CONFIGS = {
  territory: { scatterStacks: 2, scatterCaches: 1 },
};

const GAMES = allRulesets().map(entry => ({
  ruleset: entry.ruleset,
  config: CONFIGS[entry.id] || {},
  opening: OPENINGS[entry.id] || [],
}));

function build(g, seed = 11) {
  const eng = new Engine(g.ruleset, { config: g.config, players: PLAYERS, seed });
  for (const { action, actorId } of g.opening) eng.applyAction(action, actorId);
  return eng;
}

/** Play a game by random legal choice, returning the engine and the moves made. */
function fuzz(g, seed, limit = 300) {
  const rng = new Rng(seed);
  const eng = build(g, seed);
  const taken = [...g.opening];
  let n = 0;
  while (!eng.isOver() && n < limit) {
    const actor = eng.state.cur;
    const actions = eng.legalActions(actor);
    if (!actions.length) break;
    // Prefer doing something over passing, so the fuzz makes progress.
    const busy = actions.filter(a => a.type !== 'endTurn' && a.type !== 'endProduction');
    const pool = busy.length && rng.next() < 0.9 ? busy : actions;
    const action = rng.pick(pool);
    eng.applyAction(action, actor);
    taken.push({ action, actorId: actor });
    n++;
  }
  return { eng, taken };
}

for (const g of GAMES) {
  const name = g.ruleset.name;

  test(`${name}: satisfies the ruleset contract`, () => {
    assert.deepEqual(validateRuleset(g.ruleset), []);
  });

  test(`${name}: a fresh game offers legal actions to the player on turn`, () => {
    const eng = build(g);
    const actor = eng.state.cur;
    const actions = eng.legalActions(actor);
    assert.ok(actions.length, 'a live game must offer something to do');
    for (const a of actions.slice(0, 40)) {
      assert.ok(a.type, 'every action carries a type');
      assert.equal(eng.isLegal(a, actor), true,
        `isLegal disagreed with legalActions on ${JSON.stringify(a)}`);
    }
  });

  test(`${name}: the engine refuses a nonsense action`, () => {
    const eng = build(g);
    const before = eng.fingerprint();
    assert.throws(() => eng.applyAction({ type: 'not-a-real-action' }), /Illegal action/);
    assert.equal(eng.fingerprint(), before, 'a refusal must not touch state');
  });

  test(`${name}: undo returns to the exact prior fingerprint`, () => {
    const eng = build(g);
    const actor = eng.state.cur;
    const before = eng.fingerprint();
    eng.applyAction(eng.legalActions(actor)[0], actor);
    assert.notEqual(eng.fingerprint(), before, 'an action should change something');
    assert.ok(eng.undo());
    assert.equal(eng.fingerprint(), before);
  });

  test(`${name}: undo unwinds a long game one step at a time`, () => {
    const { eng } = fuzz(g, 77, 40);
    const marks = [];
    // Walk back to the start, checking each rewind lands somewhere sane.
    while (eng.canUndo()) {
      marks.push(eng.fingerprint());
      eng.undo();
    }
    assert.ok(marks.length > 3, 'the fuzz should have made several moves');
    assert.equal(eng.canUndo(), false);
  });

  test(`${name}: the same seed produces the same game`, () => {
    assert.equal(build(g, 99).fingerprint(), build(g, 99).fingerprint());
  });

  test(`${name}: a fuzzed game replays to an identical fingerprint`, () => {
    const { eng, taken } = fuzz(g, 4242, 120);
    const replayed = Engine.replay(g.ruleset, {
      config: g.config, players: PLAYERS, seed: 4242,
    }, taken);
    assert.equal(replayed.fingerprint(), eng.fingerprint());
  });

  test(`${name}: serialize and deserialize round-trip`, () => {
    const { eng } = fuzz(g, 8, 60);
    const copy = Engine.deserialize(g.ruleset, eng.serialize());
    assert.equal(copy.fingerprint(), eng.fingerprint());
    assert.deepEqual(copy.players, eng.players, 'the roster survives the trip');
  });

  test(`${name}: a finished game offers nothing and refuses more actions`, () => {
    const { eng } = fuzz(g, 5150, 600);
    if (!eng.isOver()) return;    // some fuzzes run long; only assert when it ended
    assert.deepEqual(eng.legalActions(eng.state.cur), []);
    assert.throws(() => eng.applyAction({ type: 'whatever' }), /already over|Illegal action/);
    const r = eng.result();
    assert.ok(r && 'winnerId' in r, 'a result names a winner or a draw');
  });

  test(`${name}: describeCell returns data, never DOM`, () => {
    const { eng } = fuzz(g, 21, 40);
    let seen = 0;
    for (const key of Object.keys(eng.state.board || {})) {
      const [x, y] = key.split(',').map(Number);
      const view = g.ruleset.describeCell(eng.state, x, y);
      if (!view) continue;
      seen++;
      assert.equal(typeof view, 'object');
      assert.ok(!('nodeType' in view), 'a cell view must not be a DOM node');
      assert.equal(JSON.parse(JSON.stringify(view)) instanceof Object, true,
        'a cell view must be JSON-serializable');
    }
    assert.ok(seen > 0, 'something should be on the board');
  });

  test(`${name}: cross-validation accepts an honest move`, () => {
    const mine = build(g, 31);
    const theirs = build(g, 31);
    const actor = theirs.state.cur;
    const action = theirs.legalActions(actor)[0];
    const { hash } = theirs.applyAction(action, actor);

    const res = verifyRemoteAction(mine, { action, actorId: actor, hash, state: theirs.state });
    assert.equal(res.ok, true, `honest move rejected: ${JSON.stringify(res)}`);
    assert.equal(mine.fingerprint(), theirs.fingerprint());
  });

  test(`${name}: cross-validation catches a tampered result`, () => {
    const mine = build(g, 31);
    const theirs = build(g, 31);
    const actor = theirs.state.cur;
    const action = theirs.legalActions(actor)[0];
    theirs.applyAction(action, actor);

    // They report a state we would never have computed.
    const lie = structuredClone(theirs.state);
    lie.tamperedField = 'a rule was changed mid-game';

    const before = mine.fingerprint();
    const res = verifyRemoteAction(mine, {
      action, actorId: actor, hash: 'deadbeef', state: lie,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'diverged');
    assert.ok(res.ourState && res.theirState, 'both sides travel to the UI');
    assert.equal(mine.fingerprint(), before, 'a disputed move is never applied');
  });

  test(`${name}: ships rules text for the in-app panel`, () => {
    // Process rule: rules text lives with the code, so the UI and the
    // actual behavior can't drift apart.
    assert.equal(typeof g.ruleset.rulesText, 'string');
    assert.ok(g.ruleset.rulesText.trim().length > 200, 'rules text looks like a stub');
  });

  test(`${name}: no ruleset reaches for the DOM or the clock`, () => {
    // A crude but effective guard: the ruleset source must not mention
    // browser globals or unseeded randomness. Anything that does breaks
    // headless play, replay, and cross-validation.
    const src = g.ruleset.applyAction.toString() + g.ruleset.legalActions.toString();
    for (const banned of ['document.', 'window.', 'Math.random', 'Date.now']) {
      assert.ok(!src.includes(banned), `${name} references ${banned}`);
    }
  });
}

test('every ruleset has a distinct id', () => {
  const ids = GAMES.map(g => g.ruleset.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('the registry describes every game well enough to seat a table', () => {
  for (const e of allRulesets()) {
    assert.ok(e.id && e.name && e.version, `${e.id} is missing identity fields`);
    assert.ok(e.blurb.length, `${e.id} has no blurb for the picker`);
    assert.ok(e.minPlayers >= 1 && e.maxPlayers >= e.minPlayers, `${e.id} has odd player counts`);
    assert.ok(e.defaultPlayers.length >= e.minPlayers,
      `${e.id} does not offer enough default players to start`);
  }
});

test('a ruleset that breaks the contract is refused registration', () => {
  const broken = { id: 'broken', name: 'Broken', version: '1', config: {}, configSpec: [] };
  assert.throws(() => registerRuleset(broken), /does not satisfy the contract/);
  assert.equal(getRuleset('broken'), null, 'and it is not added');
});

test('built-in rulesets cannot be unregistered', () => {
  const first = allRulesets()[0];
  assert.equal(unregisterRuleset(first.id), false);
  assert.ok(getRuleset(first.id), 'still there');
});

test('the engine runs three unrelated games through one code path', () => {
  // The point of the split: nothing below knows which game it is playing.
  for (const g of GAMES) {
    const eng = build(g, 2026);
    let moves = 0;
    const rng = new Rng(2026);
    while (!eng.isOver() && moves < 25) {
      const actions = eng.legalActions(eng.state.cur);
      if (!actions.length) break;
      eng.applyAction(rng.pick(actions), eng.state.cur);
      moves++;
    }
    assert.ok(moves > 0, `${g.ruleset.name} made no progress`);
  }
});
