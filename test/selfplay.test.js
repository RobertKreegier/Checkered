import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.js';
import { Rng } from '../src/rng.js';
import territory from '../rulesets/territory.js';

const PLAYERS = [
  { name: 'Vermilion', unit: '#E2574C', armory: '#F2C14E' },
  { name: 'Cobalt', unit: '#3E8FD0', armory: '#8FD8E8' },
];

/**
 * Play a whole game by picking uniformly at random from legalActions().
 * A random player is a terrible opponent but an excellent fuzzer: it
 * reaches board positions no hand-written test would think to build.
 */
function randomGame(seed, maxActions = 4000) {
  const rng = new Rng(seed);
  const eng = new Engine(territory, {
    config: { scatterStacks: 3, scatterCaches: 2 },
    players: PLAYERS,
    seed,
  });

  eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
  eng.applyAction({ type: 'place', x: 9, y: 2 }, 1);

  let n = 0;
  while (!eng.isOver() && n < maxActions) {
    const actor = eng.state.cur;
    const actions = eng.legalActions(actor);
    assert.ok(actions.length, `actor ${actor} had no legal action in phase ${eng.state.phase}`);

    // Bias away from ending the turn, or a random walk mostly passes.
    const substantive = actions.filter(a => a.type !== 'endTurn' && a.type !== 'endProduction');
    const pool = substantive.length && rng.next() < 0.9 ? substantive : actions;

    eng.applyAction(rng.pick(pool), actor);
    n++;
  }
  return { eng, actions: n };
}

test('a random game runs to completion without throwing', () => {
  const { eng, actions } = randomGame(1234);
  assert.ok(actions > 20, 'the game should take a real number of actions');
  assert.ok(eng.isOver() || actions >= 4000, 'it finished, or hit the action ceiling cleanly');
});

test('several random games all stay internally consistent', () => {
  for (const seed of [7, 88, 501, 9001]) {
    const { eng } = randomGame(seed, 1500);
    for (const [k, cell] of Object.entries(eng.state.board)) {
      assert.ok(cell.u >= 0, `negative units at ${k} (seed ${seed})`);
      assert.ok(cell.a >= 0, `negative armory at ${k} (seed ${seed})`);
      assert.ok(cell.o === null || eng.state.players[cell.o], `bad owner at ${k}`);
      assert.ok(!(cell.o !== null && cell.u === 0), `owned but empty stack at ${k}`);
      assert.ok(cell.u > 0 || cell.a > 0, `wholly empty cell left on the board at ${k}`);
    }
    assert.ok(eng.state.moves >= 0, `negative moves (seed ${seed})`);
  }
});

test('a random game is reproducible from its seed', () => {
  assert.equal(randomGame(4242, 400).eng.fingerprint(), randomGame(4242, 400).eng.fingerprint());
});

test('every action taken in a random game can be replayed exactly', () => {
  const rng = new Rng(31337);
  const setup = { config: { scatterStacks: 2 }, players: PLAYERS, seed: 31337 };
  const eng = new Engine(territory, setup);
  const taken = [];
  const run = (action, actorId) => { eng.applyAction(action, actorId); taken.push({ action, actorId }); };

  run({ type: 'place', x: 0, y: 0 }, 0);
  run({ type: 'place', x: 9, y: 2 }, 1);
  for (let i = 0; i < 300 && !eng.isOver(); i++) {
    const actor = eng.state.cur;
    const actions = eng.legalActions(actor);
    const substantive = actions.filter(a => a.type !== 'endTurn' && a.type !== 'endProduction');
    const pool = substantive.length && rng.next() < 0.9 ? substantive : actions;
    run(rng.pick(pool), actor);
  }

  const replayed = Engine.replay(territory, setup, taken);
  assert.equal(replayed.fingerprint(), eng.fingerprint());
});
