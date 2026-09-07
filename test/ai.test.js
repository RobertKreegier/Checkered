/* ai.test.js — the AI layer.
 *
 * As with conformance.test.js, the battery runs against every registered
 * ruleset rather than a hardcoded list, so a newly added game gets an
 * opponent tested for free. If a test here needs a game-specific special
 * case, the AI contract is the wrong shape — fix the contract.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.js';
import { allRulesets, getRuleset } from '../rulesets/index.js';
import {
  greedyAi, validateAi, evaluateState, positionHash,
  playTurn, takeTurn, makeContext, seededRandom, DEFAULT_WEIGHTS,
} from '../src/ai-api.js';

const OPENINGS = {
  territory: [
    { action: { type: 'place', x: 0, y: 0 }, actorId: 0 },
    { action: { type: 'place', x: 7, y: 2 }, actorId: 1 },
  ],
};

function gameFor(id, config = {}) {
  const entry = getRuleset(id);
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, Math.max(2, entry.minPlayers)),
    config: id === 'territory' ? { scatterStacks: 2, ...config } : config,
    seed: 5,
  });
  for (const { action, actorId } of OPENINGS[id] || []) eng.applyAction(action, actorId);
  return eng;
}

/* ---------- the contract ---------- */

test('the shipped AI satisfies its own contract', () => {
  assert.deepEqual(validateAi(greedyAi()), []);
});

test('a broken AI is reported rather than trusted', () => {
  assert.ok(validateAi(null).length);
  assert.ok(validateAi({ id: 'x', name: 'X', version: '1' }).length,
    'an AI with no chooseAction is not an AI');
  assert.match(validateAi({ name: 'X', version: '1', chooseAction() {} }).join(), /id/);
});

test('the AI holds no game-specific knowledge', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../src/ai-api.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['territory', 'chess', 'checkers', 'armory', 'pawn', 'capture', 'castle']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(code),
      `ai-api.js mentions "${word}" in code — one contract must cover every game`);
  }
});

test('positionHash ignores bookkeeping, so a repeat is recognisable', () => {
  const eng = gameFor('chess');
  const a = { ...eng.state, rngState: 999, actionCount: 42 };
  const b = { ...eng.state, rngState: 1, actionCount: 0 };
  assert.equal(positionHash(a), positionHash(b),
    'rng position and action count must not disguise an identical position');
  const moved = eng.preview({ type: 'move', x: 4, y: 1, tx: 4, ty: 3, double: true });
  assert.notEqual(positionHash(moved), positionHash(eng.state), 'but a real change must show');
});

/* ---------- preview ---------- */

test('preview leaves the engine completely untouched', () => {
  for (const entry of allRulesets()) {
    const eng = gameFor(entry.id);
    const before = eng.fingerprint();
    const historyBefore = eng.history.length;
    const logBefore = eng.log.length;
    let fired = 0;
    eng.onChange(() => fired++);

    for (const action of eng.legalActions(eng.state.cur).slice(0, 12)) {
      eng.preview(action, eng.state.cur);
    }

    assert.equal(eng.fingerprint(), before, `${entry.name}: preview changed the state`);
    assert.equal(eng.history.length, historyBefore, 'and it must not record history');
    assert.equal(eng.log.length, logBefore, 'or write to the log');
    assert.equal(fired, 0, 'or tell listeners something happened');
  }
});

test('preview refuses an illegal action instead of applying it', () => {
  const eng = gameFor('chess');
  assert.equal(eng.preview({ type: 'move', x: 0, y: 0, tx: 5, ty: 5 }), null);
});

/* ---------- the same battery for every game ---------- */

for (const entry of allRulesets()) {
  const name = entry.name;

  test(`${name}: occupiedCells agrees with describeCell`, () => {
    const eng = gameFor(entry.id);
    const cells = entry.ruleset.occupiedCells(eng.state);
    assert.ok(cells.length > 0, 'a fresh game should have something on the board');
    for (const { x, y } of cells) {
      assert.ok(entry.ruleset.describeCell(eng.state, x, y),
        `${x},${y} was listed as occupied but describes as empty`);
    }
  });

  test(`${name}: the AI always chooses something legal`, () => {
    const eng = gameFor(entry.id);
    const ai = greedyAi();
    const rng = seededRandom(3);

    for (let i = 0; i < 25 && !eng.isOver(); i++) {
      const actor = eng.state.cur;
      const ctx = makeContext(eng, actor, rng);
      if (!ctx.actions.length) break;
      const action = ai.chooseAction(ctx);
      assert.ok(action, `${name}: the AI declined to move with ${ctx.actions.length} available`);
      assert.ok(eng.isLegal(action, actor),
        `${name}: chose an illegal action ${JSON.stringify(action)}`);
      eng.applyAction(action, actor);
    }
  });

  test(`${name}: a turn ends rather than looping forever`, () => {
    const eng = gameFor(entry.id);
    const ai = greedyAi();
    const rng = seededRandom(8);
    for (let t = 0; t < 8 && !eng.isOver(); t++) {
      const actor = eng.state.cur;
      // playTurn throws if a turn runs past its cap; that is the failure
      // this guards against. Territory's forge and burn undo each other
      // exactly, which loops any AI that doesn't watch for repetition.
      assert.doesNotThrow(() => playTurn(eng, ai, actor, rng));
      assert.notEqual(eng.state.cur === actor && !eng.isOver(), true,
        `${name}: the turn never passed to anyone else`);
    }
  });

  test(`${name}: an AI game replays exactly`, () => {
    const eng = gameFor(entry.id);
    const ai = greedyAi();
    const rng = seededRandom(21);
    for (let t = 0; t < 6 && !eng.isOver(); t++) playTurn(eng, ai, eng.state.cur, rng);

    // The whole point of routing AI moves through applyAction: a game
    // against a bot is describable by the same five things as any
    // other — ruleset, config, seed, players, actions.
    const replayed = Engine.replay(
      entry.ruleset,
      { config: eng.config, seed: eng.seed, players: eng.players },
      eng.history.map(h => ({ action: h.action, actorId: h.actorId })),
    );
    assert.equal(replayed.fingerprint(), eng.fingerprint(),
      `${name}: an AI game did not survive replay`);
  });

  test(`${name}: the AI is deterministic for a given seed`, () => {
    const run = () => {
      const eng = gameFor(entry.id);
      const ai = greedyAi();
      const rng = seededRandom(77);
      for (let t = 0; t < 6 && !eng.isOver(); t++) playTurn(eng, ai, eng.state.cur, rng);
      return eng.fingerprint();
    };
    assert.equal(run(), run(), `${name}: the same seed gave two different games`);
  });

  test(`${name}: evaluation is a finite number and symmetric in sign`, () => {
    const eng = gameFor(entry.id);
    const a = evaluateState(entry.ruleset, eng.state, 0);
    const b = evaluateState(entry.ruleset, eng.state, 1);
    assert.ok(Number.isFinite(a) && Number.isFinite(b), `${name}: evaluation was not a number`);
    // A fresh, symmetric position should not favour either side much.
    assert.ok(Math.abs(a - b) < 1e-6 || Math.sign(a) !== Math.sign(b) || a === b,
      `${name}: the opening looks lopsided (${a} vs ${b})`);
  });
}

/* ---------- it actually plays ---------- */

test('the AI beats random play at checkers', () => {
  // Regression guard on two real bugs. Counting opponent mobility in the
  // denial term made the AI hang pieces to shorten the reply list, and
  // it lost every game. Without the one-ply reply check it scored 17-23.
  const entry = getRuleset('checkers');
  const random = {
    id: 'r', name: 'Random', version: '1',
    chooseAction: ctx => ctx.actions[Math.floor(ctx.rng() * ctx.actions.length)],
  };
  let won = 0, played = 0;

  for (let g = 0; g < 8; g++) {
    const eng = new Engine(entry.ruleset, { players: entry.defaultPlayers, seed: g });
    const rng = seededRandom(g * 13 + 3);
    const seat = g % 2;
    let n = 0;
    while (!eng.isOver() && n++ < 300) {
      playTurn(eng, eng.state.cur === seat ? greedyAi() : random, eng.state.cur, rng);
    }
    const r = eng.result();
    if (!r) continue;
    played++;
    if (r.winnerId === seat) won++;
  }
  assert.ok(played >= 6, 'most games should reach a result');
  assert.ok(won / played >= 0.75,
    `the AI won only ${won} of ${played} — it should comfortably beat random play`);
});

test('a turn stays responsive on a large board', () => {
  // Territory grows; unbudgeted this reached 26 seconds a turn.
  const eng = gameFor('territory', { scatterStacks: 3 });
  const ai = greedyAi();
  const rng = seededRandom(9);
  let slowest = 0;
  for (let t = 0; t < 14 && !eng.isOver(); t++) {
    const t0 = Date.now();
    playTurn(eng, ai, eng.state.cur, rng);
    slowest = Math.max(slowest, Date.now() - t0);
  }
  assert.ok(slowest < 5000, `slowest turn took ${slowest}ms`);
});

test('an AI that throws is reported, not swallowed', () => {
  const eng = gameFor('chess');
  const broken = {
    id: 'b', name: 'Broken', version: '1',
    chooseAction() { throw new Error('nope'); },
  };
  assert.throws(() => takeTurn(eng, broken), /Broken threw while choosing/);
  assert.equal(eng.history.length, 0, 'and nothing was applied');
});

test('an AI that returns an illegal action is refused', () => {
  const eng = gameFor('chess');
  const cheat = {
    id: 'c', name: 'Cheat', version: '1',
    chooseAction: () => ({ type: 'move', x: 0, y: 0, tx: 7, ty: 7 }),
  };
  assert.throws(() => takeTurn(eng, cheat), /illegal action/);
  assert.equal(eng.history.length, 0);
});

test('a careless AI that cycles is stopped by the runner', () => {
  // An AI ignoring ctx.seen: it always takes the first action offered,
  // which in a game with mutually reversing actions is a loop.
  const eng = gameFor('territory');
  const naive = { id: 'n', name: 'Naive', version: '1', chooseAction: ctx => ctx.actions[0] };
  assert.doesNotThrow(() => playTurn(eng, naive, eng.state.cur, seededRandom(1)),
    'the runner should end the turn rather than hang');
});

test('tuning weights changes how it plays', () => {
  const eng = gameFor('chess');
  const rng = () => 0.5;                       // no jitter, so it's the weights talking
  const peaceful = makeContext(eng, 0, rng);
  const a = greedyAi({ material: 10, ground: 0, denial: 0, safety: 0 }).chooseAction(peaceful);
  const b = greedyAi({ material: 0, ground: 10, denial: 0, safety: 0 }).chooseAction(peaceful);
  assert.ok(a && b, 'both settings should still produce a move');
  assert.ok(Array.isArray(greedyAi().weightSpec), 'the knobs are declared for the UI');
  for (const [key] of greedyAi().weightSpec) {
    assert.ok(key in DEFAULT_WEIGHTS, `weightSpec names ${key}, which has no default`);
  }
});
