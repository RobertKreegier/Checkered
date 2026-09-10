import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine, verifyRemoteAction } from '../root/src/engine.js';
import { Rng, seedFromString } from '../root/src/rng.js';
import { hashState, canonical, firstDifference } from '../root/src/hash.js';
import { validateRuleset } from '../root/src/ruleset-api.js';
import territory from '../root/rulesets/territory.js';
import { getRuleset } from '../root/rulesets/index.js';

/* A minimal ruleset, so engine tests don't depend on Territory's rules. */
function tinyRuleset() {
  return {
    id: 'tiny', name: 'Tiny', version: '1',
    config: { target: 3 },
    configSpec: [['Play', [['target', 'Points to win', 'num']]]],
    createInitialState(config) {
      return { config: { ...config }, cur: 0, scores: [0, 0], done: false };
    },
    legalActions(state, actorId) {
      if (state.done || actorId !== state.cur) return [];
      return [{ type: 'score', n: 1 }, { type: 'score', n: 2 }, { type: 'pass' }];
    },
    applyAction(state, action) {
      if (action.type === 'score') state.scores[state.cur] += action.n;
      if (state.scores[state.cur] >= state.config.target) state.done = true;
      const log = [`p${state.cur} ${action.type}`];
      if (!state.done) state.cur = (state.cur + 1) % 2;
      return log;
    },
    isTerminal(state) {
      return state.done ? { winnerId: state.cur, reason: 'reached target' } : null;
    },
    describeCell() { return null; },
  };
}

test('rng is deterministic and restorable from its stored position', () => {
  const a = new Rng(12345);
  const first = [a.next(), a.next(), a.next()];
  const b = new Rng(12345);
  assert.deepEqual([b.next(), b.next(), b.next()], first);

  const mid = a.state;
  const after = [a.next(), a.next()];
  const resumed = new Rng(mid);
  assert.deepEqual([resumed.next(), resumed.next()], after);
});

test('seedFromString is stable and spreads different strings apart', () => {
  assert.equal(seedFromString('table-7'), seedFromString('table-7'));
  assert.notEqual(seedFromString('table-7'), seedFromString('table-8'));
});

test('canonical form ignores key order so two clients agree', () => {
  assert.equal(canonical({ a: 1, b: [2, { d: 4, c: 3 }] }), canonical({ b: [2, { c: 3, d: 4 }], a: 1 }));
  assert.equal(hashState({ x: 1, y: 2 }), hashState({ y: 2, x: 1 }));
});

test('firstDifference points at the diverging path', () => {
  const diff = firstDifference({ board: { '0,0': { u: 3 } } }, { board: { '0,0': { u: 4 } } });
  assert.equal(diff.path, 'board.0,0.u');
  assert.equal(diff.mine, 3);
  assert.equal(diff.theirs, 4);
  assert.equal(firstDifference({ a: 1 }, { a: 1 }), null);
});

test('validateRuleset catches a missing function and a bad config key', () => {
  const rs = tinyRuleset();
  delete rs.isTerminal;
  rs.configSpec = [['Play', [['nope', 'Missing key', 'num']]]];
  const problems = validateRuleset(rs);
  assert.ok(problems.some(p => p.includes('isTerminal')));
  assert.ok(problems.some(p => p.includes('nope')));
  assert.equal(validateRuleset(tinyRuleset()).length, 0);
});

test('engine refuses an illegal action instead of applying it', () => {
  const eng = new Engine(tinyRuleset());
  const before = eng.fingerprint();
  assert.throws(() => eng.applyAction({ type: 'score', n: 99 }), /Illegal action/);
  assert.equal(eng.fingerprint(), before, 'state must be untouched after a refusal');
});

test('engine refuses to act for the wrong actor', () => {
  const eng = new Engine(tinyRuleset());
  assert.throws(() => eng.applyAction({ type: 'score', n: 1 }, 1), /Illegal action/);
});

test('undo restores state and truncates the log', () => {
  const eng = new Engine(tinyRuleset());
  const start = eng.fingerprint();
  eng.applyAction({ type: 'score', n: 2 });
  assert.notEqual(eng.fingerprint(), start);
  assert.equal(eng.log.length, 1);
  assert.ok(eng.undo());
  assert.equal(eng.fingerprint(), start);
  assert.equal(eng.log.length, 0);
  assert.equal(eng.undo(), false);
});

test('undoTo rewinds several actions at once', () => {
  const eng = new Engine(tinyRuleset());
  eng.applyAction({ type: 'score', n: 1 });
  const mark = eng.fingerprint();
  const at = eng.history.length;
  eng.applyAction({ type: 'score', n: 1 }, 1);
  eng.applyAction({ type: 'score', n: 1 });
  eng.undoTo(at);
  assert.equal(eng.fingerprint(), mark);
  assert.equal(eng.history.length, at);
});

test('a ruleset that throws mid-action leaves state unchanged', () => {
  const rs = tinyRuleset();
  rs.applyAction = state => { state.scores[0] = 999; throw new Error('boom'); };
  const eng = new Engine(rs);
  const before = eng.fingerprint();
  assert.throws(() => eng.applyAction({ type: 'pass' }), /boom/);
  assert.equal(eng.fingerprint(), before, 'half-applied damage must be rolled back');
});

test('serialize/deserialize round-trips to the same fingerprint', () => {
  const eng = new Engine(tinyRuleset(), { seed: 9 });
  eng.applyAction({ type: 'score', n: 2 });
  const copy = Engine.deserialize(tinyRuleset(), eng.serialize());
  assert.equal(copy.fingerprint(), eng.fingerprint());
});

test('replaying the same actions reproduces the same fingerprint', () => {
  const actions = [
    { action: { type: 'score', n: 1 }, actorId: 0 },
    { action: { type: 'score', n: 2 }, actorId: 1 },
  ];
  const a = Engine.replay(tinyRuleset(), { seed: 4 }, actions);
  const b = Engine.replay(tinyRuleset(), { seed: 4 }, actions);
  assert.equal(a.fingerprint(), b.fingerprint());
});

/* ---------- multiplayer cross-validation ---------- */

test('verifyRemoteAction accepts a move both sides compute identically', () => {
  const mine = new Engine(tinyRuleset(), { seed: 3 });
  const theirs = new Engine(tinyRuleset(), { seed: 3 });
  const { hash } = theirs.applyAction({ type: 'score', n: 2 });

  const res = verifyRemoteAction(mine, {
    action: { type: 'score', n: 2 }, actorId: 0, hash, state: theirs.state,
  });
  assert.equal(res.ok, true);
  assert.equal(mine.fingerprint(), theirs.fingerprint(), 'accepted move is applied locally');
});

test('verifyRemoteAction flags a divergence and reports what differed', () => {
  const mine = new Engine(tinyRuleset(), { seed: 3 });
  const theirs = new Engine(tinyRuleset(), { seed: 3 });
  theirs.applyAction({ type: 'score', n: 2 });
  theirs.state.scores[0] = 50;            // they claim a state we'd never compute

  const before = mine.fingerprint();
  const res = verifyRemoteAction(mine, {
    action: { type: 'score', n: 2 }, actorId: 0,
    hash: theirs.fingerprint(), state: theirs.state,
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'diverged');
  assert.ok(res.ourState && res.theirState, 'both states travel to the UI');
  assert.equal(res.difference.path, 'scores.0');
  assert.equal(mine.fingerprint(), before, 'a disputed move is not applied');
});

test('verifyRemoteAction rejects an action our rules call illegal', () => {
  const mine = new Engine(tinyRuleset(), { seed: 3 });
  const res = verifyRemoteAction(mine, {
    action: { type: 'score', n: 99 }, actorId: 0, hash: 'whatever',
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'rejected');
  assert.match(res.detail, /Illegal action/);
});

test('editing config does not leak back into the ruleset module', () => {
  const eng = new Engine(territory, { config: { startCamp: 99 } });
  assert.equal(eng.config.startCamp, 99);
  assert.equal(territory.config.startCamp, 8, 'the module default is untouched');
});

/* ---------- the record points back at the right action ---------- */

test('every log line records which action wrote it', () => {
  // One action can write several lines, so a line's position in the log
  // is not its position in the history. Anything rewinding by log index
  // rewinds to the wrong place.
  const entry = getRuleset('territory');
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, 2), config: { scatterStacks: 1 }, seed: 4,
  });
  eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
  eng.applyAction({ type: 'place', x: 7, y: 1 }, 1);

  assert.ok(eng.log.length > eng.history.length,
    'this game should write more lines than it has actions');
  for (const line of eng.log) {
    assert.equal(typeof line.at, 'number', 'every line needs its action');
    assert.ok(line.at < eng.history.length);
  }
});

test('the first line of an action is marked, and later ones are not', () => {
  const entry = getRuleset('territory');
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, 2), config: { scatterStacks: 1 }, seed: 4,
  });
  eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
  const leads = eng.log.filter(l => l.lead);
  assert.equal(leads.length, 1, 'exactly one line describes the action itself');
  assert.equal(leads[0].at, 0);
});

test('rewinding to a line lands where a player would expect', () => {
  const entry = getRuleset('territory');
  const fresh = () => {
    const e = new Engine(entry.ruleset, {
      players: entry.defaultPlayers.slice(0, 2), config: { scatterStacks: 1 }, seed: 4,
    });
    e.applyAction({ type: 'place', x: 0, y: 0 }, 0);
    return e;
  };

  const afterFirst = fresh().fingerprint();
  const eng = fresh();
  eng.applyAction({ type: 'place', x: 7, y: 1 }, 1);
  const atPlayStart = eng.fingerprint();
  eng.applyAction(eng.legalActions(0).find(a => a.type === 'produce'), 0);

  const target = line => (line.lead ? line.at : line.at + 1);

  // A line describing a consequence — the play beginning — rewinds to
  // just after its action, since there is no moment in between.
  const begins = eng.log.find(l => /play begins/.test(l.text));
  const a = fresh();
  a.applyAction({ type: 'place', x: 7, y: 1 }, 1);
  a.applyAction(a.legalActions(0).find(x => x.type === 'produce'), 0);
  a.undoTo(target(begins));
  assert.equal(a.fingerprint(), atPlayStart,
    'clicking "play begins" should return to the start of that play');

  // A line describing the action itself rewinds to before it.
  const placed = eng.log.find(l => /Cobalt pitched/.test(l.text));
  const b = fresh();
  b.applyAction({ type: 'place', x: 7, y: 1 }, 1);
  b.undoTo(target(placed));
  assert.equal(b.fingerprint(), afterFirst, 'clicking a placement should undo it');
});
