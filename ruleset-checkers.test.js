import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.js';
import { Rng } from '../src/rng.js';
import checkers from '../rulesets/checkers.js';

const { K, at, countPieces } = checkers.helpers;
const PLAYERS = [{ name: 'Red' }, { name: 'Black' }];

function game(config = {}) {
  return new Engine(checkers, { players: PLAYERS, config, seed: 1 });
}

/** Replace the board wholesale to isolate one rule. */
function setBoard(eng, cells) {
  eng.state.board = {};
  for (const [k, v] of Object.entries(cells)) eng.state.board[k] = { ...v };
}

const paths = eng => eng.legalActions(eng.state.cur).map(a => a.path);

/* ---------- setup ---------- */

test('the opening board has twelve pieces a side on dark squares', () => {
  const eng = game();
  assert.equal(countPieces(eng.state, 0), 12);
  assert.equal(countPieces(eng.state, 1), 12);
  for (const k of Object.keys(eng.state.board)) {
    const [x, y] = k.split(',').map(Number);
    assert.equal((x + y) % 2, 1, `piece on a light square at ${k}`);
  }
});

test('the opening position offers seven moves', () => {
  const eng = game();
  assert.equal(eng.legalActions(0).length, 7);
});

/* ---------- movement ---------- */

test('men move only forward', () => {
  const eng = game();
  setBoard(eng, { '3,3': { o: 0, king: false } });
  const targets = paths(eng).map(p => p.split('>')[1]);
  assert.deepEqual(targets.sort(), ['2,4', '4,4'], 'player 0 moves up the board');
});

test('kings move in all four directions', () => {
  const eng = game();
  setBoard(eng, { '3,3': { o: 0, king: true } });
  assert.equal(paths(eng).length, 4);
});

/* ---------- captures ---------- */

test('a capture is compulsory when one is available', () => {
  const eng = game();
  setBoard(eng, {
    '3,3': { o: 0, king: false },
    '4,4': { o: 1, king: false },
    '0,0': { o: 0, king: false },   // has a quiet move, but must not be offered
  });
  const list = paths(eng);
  assert.deepEqual(list, ['3,3>5,5'], 'only the jump is legal');
});

test('captures can be turned off in config', () => {
  const eng = game({ mustCapture: false });
  setBoard(eng, {
    '3,3': { o: 0, king: false },
    '4,4': { o: 1, king: false },
  });
  assert.ok(paths(eng).length > 1, 'quiet moves reappear alongside the jump');
});

test('a jump removes the piece it hopped', () => {
  const eng = game();
  setBoard(eng, { '3,3': { o: 0, king: false }, '4,4': { o: 1, king: false } });
  eng.applyAction({ type: 'move', path: '3,3>5,5' });
  assert.equal(at(eng.state, 4, 4), null, 'the jumped man is captured');
  assert.equal(at(eng.state, 5, 5).o, 0);
});

test('a double jump is one action, not two turns', () => {
  const eng = game();
  setBoard(eng, {
    '1,1': { o: 0, king: false },
    '2,2': { o: 1, king: false },
    '4,4': { o: 1, king: false },
  });
  assert.deepEqual(paths(eng), ['1,1>3,3>5,5']);
  eng.applyAction({ type: 'move', path: '1,1>3,3>5,5' });
  assert.equal(countPieces(eng.state, 1), 0, 'both men taken in one action');
  assert.equal(eng.state.cur, 1, 'and the turn passes exactly once');
});

test('a jump sequence must be played to its end', () => {
  const eng = game();
  setBoard(eng, {
    '1,1': { o: 0, king: false },
    '2,2': { o: 1, king: false },
    '4,4': { o: 1, king: false },
  });
  assert.equal(eng.isLegal({ type: 'move', path: '1,1>3,3' }), false,
    'stopping halfway is not a legal action');
});

test('the same man cannot be jumped twice in one sequence', () => {
  const eng = game();
  setBoard(eng, {
    '3,3': { o: 0, king: true },
    '4,4': { o: 1, king: false },
  });
  for (const p of paths(eng)) {
    assert.equal(p.split('>').length, 2, `runaway sequence: ${p}`);
  }
});

/* ---------- crowning ---------- */

test('a man reaching the far rank is crowned', () => {
  const eng = game();
  setBoard(eng, { '2,6': { o: 0, king: false }, '0,0': { o: 1, king: false } });
  eng.applyAction({ type: 'move', path: '2,6>3,7' });
  assert.equal(at(eng.state, 3, 7).king, true);
});

test('crowning ends a jump sequence when configured to', () => {
  // Red jumps to 5,7 — the back rank — with another jump still on offer.
  const board = {
    '3,5': { o: 0, king: false },
    '4,6': { o: 1, king: false },
    '6,6': { o: 1, king: false },   // a further jump the new king could take
  };
  const stops = game({ promotionEndsTurn: true });
  setBoard(stops, board);
  assert.deepEqual(paths(stops), ['3,5>5,7'], 'the crown stops the sequence');

  const carries = game({ promotionEndsTurn: false });
  setBoard(carries, board);
  assert.deepEqual(paths(carries), ['3,5>5,7>7,5'], 'otherwise the new king jumps on');
});

test('player 1 is crowned at the other end of the board', () => {
  const eng = game();
  setBoard(eng, { '2,1': { o: 1, king: false }, '7,7': { o: 0, king: false } });
  eng.state.cur = 1;
  eng.applyAction({ type: 'move', path: '2,1>3,0' }, 1);
  assert.equal(at(eng.state, 3, 0).king, true);
});

/* ---------- endings ---------- */

test('losing every piece loses the game', () => {
  const eng = game();
  setBoard(eng, { '3,3': { o: 0, king: false }, '4,4': { o: 1, king: false } });
  eng.applyAction({ type: 'move', path: '3,3>5,5' });
  const r = eng.result();
  assert.ok(r);
  assert.equal(r.winnerId, 0);
  assert.equal(r.reason, 'every piece captured');
});

test('a player with no legal move loses', () => {
  const eng = game();
  // Black's last man sits in the corner: its only step is blocked by a
  // red man, and the square behind that man is occupied too, so it
  // cannot jump either.
  setBoard(eng, {
    '0,7': { o: 1, king: false },
    '1,6': { o: 0, king: false },
    '2,5': { o: 0, king: false },
    '5,0': { o: 0, king: false },   // red has a free move to make elsewhere
  });
  eng.state.cur = 0;
  eng.applyAction({ type: 'move', path: '5,0>6,1' });
  const r = eng.result();
  assert.ok(r, 'the game ended');
  assert.equal(r.winnerId, 0);
  assert.equal(r.reason, 'no legal move');
});

test('a long quiet stretch is drawn', () => {
  const eng = game({ drawAfterQuietMoves: 2 });
  setBoard(eng, { '3,3': { o: 0, king: true }, '4,6': { o: 1, king: true } });
  const shuffle = ['3,3>2,4', '4,6>5,5', '2,4>3,3', '5,5>4,6'];
  for (const path of shuffle) {
    if (eng.isOver()) break;
    eng.applyAction({ type: 'move', path }, eng.state.cur);
  }
  const r = eng.result();
  assert.ok(r, 'the shuffle was cut short');
  assert.equal(r.winnerId, null);
});

/* ---------- engine integration ---------- */

test('the engine refuses an illegal checkers move', () => {
  const eng = game();
  assert.throws(() => eng.applyAction({ type: 'move', path: '0,0>7,7' }), /Illegal action/);
});

test('undo restores captured men', () => {
  const eng = game();
  setBoard(eng, {
    '1,1': { o: 0, king: false },
    '2,2': { o: 1, king: false },
    '4,4': { o: 1, king: false },
  });
  const before = eng.fingerprint();
  eng.applyAction({ type: 'move', path: '1,1>3,3>5,5' });
  assert.equal(countPieces(eng.state, 1), 0);
  eng.undo();
  assert.equal(eng.fingerprint(), before);
  assert.equal(countPieces(eng.state, 1), 2);
});

test('a random checkers game finishes and stays consistent', () => {
  const rng = new Rng(2024);
  const eng = game();
  let n = 0;
  while (!eng.isOver() && n < 400) {
    const actions = eng.legalActions(eng.state.cur);
    assert.ok(actions.length, 'a live game must offer a move');
    eng.applyAction(rng.pick(actions), eng.state.cur);
    n++;
  }
  for (const [k, p] of Object.entries(eng.state.board)) {
    const [x, y] = k.split(',').map(Number);
    assert.ok(x >= 0 && x < 8 && y >= 0 && y < 8, `piece off the board at ${k}`);
    assert.ok(p.o === 0 || p.o === 1, `bad owner at ${k}`);
  }
});

test('a checkers game replays to the same fingerprint', () => {
  const setup = { players: PLAYERS, config: {}, seed: 3 };
  const actions = [
    { action: { type: 'move', path: '1,2>0,3' }, actorId: 0 },
    { action: { type: 'move', path: '2,5>3,4' }, actorId: 1 },
  ];
  assert.equal(
    Engine.replay(checkers, setup, actions).fingerprint(),
    Engine.replay(checkers, setup, actions).fingerprint());
});

test('describeCell distinguishes men from kings', () => {
  const eng = game();
  setBoard(eng, { '3,3': { o: 0, king: true }, '4,4': { o: 1, king: false } });
  assert.equal(checkers.describeCell(eng.state, 3, 3).label, 'KING');
  assert.equal(checkers.describeCell(eng.state, 4, 4).label, 'MAN');
  assert.equal(checkers.describeCell(eng.state, 0, 0), null);
});
