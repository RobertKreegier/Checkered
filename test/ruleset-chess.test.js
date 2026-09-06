import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.js';
import chess from '../rulesets/chess.js';

const { legalMoves, makeMove, cloneForTrial, loadFEN, toFEN, inCheck, sq } = chess.helpers;

const PLAYERS = [{ name: 'White' }, { name: 'Black' }];

function game(fen) {
  return new Engine(chess, { players: PLAYERS, config: fen ? { fen } : {} });
}

/** Bare state from a FEN, for move-generation work that skips the engine. */
function pos(fen) {
  return { config: chess.config, ...loadFEN(fen), history: [], result: null, players: [] };
}

/**
 * perft: count leaf nodes at a given depth. This is the standard way to
 * validate a chess move generator — every legality rule (pins, castling
 * through check, en passant discovery, promotion) shows up as a wrong
 * number, and the reference counts are widely published.
 */
function perft(state, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(state, state.cur);
  if (depth === 1) return moves.length;
  let total = 0;
  for (const m of moves) {
    const next = cloneForTrial(state);
    makeMove(next, m);
    total += perft(next, depth - 1);
  }
  return total;
}

/* ---------- FEN ---------- */

test('FEN round-trips through the board and back', () => {
  for (const fen of [
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
    '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  ]) {
    assert.equal(toFEN(pos(fen)), fen);
  }
});

/* ---------- perft, the real test of the generator ---------- */

test('perft from the opening position matches known counts', () => {
  const p = pos(chess.helpers.FEN_START);
  assert.equal(perft(p, 1), 20);
  assert.equal(perft(p, 2), 400);
  assert.equal(perft(p, 3), 8902);
  assert.equal(perft(p, 4), 197281);
});

test('perft on Kiwipete exercises castling, pins and en passant', () => {
  const p = pos('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(perft(p, 1), 48);
  assert.equal(perft(p, 2), 2039);
  assert.equal(perft(p, 3), 97862);
});

test('perft on a rook-and-pawn endgame with en passant tricks', () => {
  const p = pos('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.equal(perft(p, 1), 14);
  assert.equal(perft(p, 2), 191);
  assert.equal(perft(p, 3), 2812);
  assert.equal(perft(p, 4), 43238);
});

test('perft on a promotion-heavy position', () => {
  const p = pos('n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1');
  assert.equal(perft(p, 1), 24);
  assert.equal(perft(p, 2), 496);
  assert.equal(perft(p, 3), 9483);
});

/* ---------- specific rules ---------- */

test('a pinned piece may not move', () => {
  // Black rook on e8, white king e1, white knight e2 caught between them.
  const p = pos('4r1k1/8/8/8/8/8/4N3/4K3 w - - 0 1');
  const knightMoves = legalMoves(p, 0).filter(m => m.x === 4 && m.y === 1);
  assert.equal(knightMoves.length, 0, 'the knight is pinned to its king');
});

test('castling is offered, and forbidden through an attacked square', () => {
  const clear = pos('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  assert.ok(legalMoves(clear, 0).some(m => m.castle === 'k'), 'kingside castling is available');

  // A black rook on f8 attacks f1, the square the king would cross.
  const blocked = pos('4kr2/8/8/8/8/8/8/4K2R w K - 0 1');
  assert.ok(!legalMoves(blocked, 0).some(m => m.castle === 'k'),
    'the king may not cross an attacked square');
});

test('castling rights are lost once the king moves', () => {
  const eng = game('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  eng.applyAction({ type: 'move', x: 4, y: 0, tx: 4, ty: 1 });
  assert.equal(eng.state.castle[0].k, false);
});

test('castling moves the rook too', () => {
  const eng = game('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  eng.applyAction({ type: 'move', x: 4, y: 0, tx: 6, ty: 0, castle: 'k' });
  assert.equal(eng.state.board['6,0'].p, 'k');
  assert.equal(eng.state.board['5,0'].p, 'r');
  assert.equal(eng.state.board['7,0'], undefined);
});

test('en passant captures the pawn that ran past', () => {
  const eng = game('4k3/8/8/8/4p3/8/3P4/4K3 w - - 0 1');
  eng.applyAction({ type: 'move', x: 3, y: 1, tx: 3, ty: 3, double: true });
  assert.equal(eng.state.ep, '3,2', 'the skipped square is marked');
  eng.applyAction({ type: 'move', x: 4, y: 3, tx: 3, ty: 2, ep: true }, 1);
  assert.equal(eng.state.board['3,3'], undefined, 'the passed pawn is gone');
  assert.equal(eng.state.board['3,2'].o, 1);
});

test('the en passant window closes after one move', () => {
  const eng = game('4k3/7p/8/8/4p3/8/3P4/4K3 w - - 0 1');
  eng.applyAction({ type: 'move', x: 3, y: 1, tx: 3, ty: 3, double: true });
  eng.applyAction({ type: 'move', x: 7, y: 6, tx: 7, ty: 5 }, 1);
  assert.equal(eng.state.ep, null);
  assert.equal(eng.isLegal({ type: 'move', x: 4, y: 3, tx: 3, ty: 2, ep: true }), false);
});

test('a pawn reaching the last rank must choose a promotion', () => {
  const p = pos('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  const promos = legalMoves(p, 0).filter(m => m.x === 0 && m.y === 6).map(m => m.promo).sort();
  assert.deepEqual(promos, ['b', 'n', 'q', 'r']);
});

test('promotion places the chosen piece', () => {
  const eng = game('4k3/P7/8/8/8/8/8/4K3 w - - 0 1');
  eng.applyAction({ type: 'move', x: 0, y: 6, tx: 0, ty: 7, promo: 'n' });
  assert.equal(eng.state.board['0,7'].p, 'n');
});

/* ---------- endings ---------- */

test('fool\u2019s mate is detected as checkmate', () => {
  const eng = game();
  const play = (x, y, tx, ty, actor, extra = {}) =>
    eng.applyAction({ type: 'move', x, y, tx, ty, ...extra }, actor);
  play(5, 1, 5, 2, 0);            // f3
  play(4, 6, 4, 4, 1, { double: true }); // e5
  play(6, 1, 6, 3, 0, { double: true }); // g4
  play(3, 7, 7, 3, 1);            // Qh4#
  const r = eng.result();
  assert.ok(r, 'the game has ended');
  assert.equal(r.reason, 'checkmate');
  assert.equal(r.winnerId, 1);
  assert.deepEqual(eng.legalActions(0), []);
});

test('stalemate is a draw, not a loss', () => {
  // Black to move, not in check, with no legal move.
  const eng = game('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.equal(eng.legalActions(1).length, 0);
  // Reach it properly so applyAction sets the result.
  const setup = game('7k/8/5QK1/8/8/8/8/8 w - - 0 1');
  setup.applyAction({ type: 'move', x: 5, y: 5, tx: 5, ty: 6 });
  const r = setup.result();
  assert.ok(r);
  assert.equal(r.reason, 'stalemate');
  assert.equal(r.winnerId, null);
});

test('bare kings are drawn for insufficient material', () => {
  const eng = game('4k3/8/8/8/8/8/4p3/4K3 w - - 0 1');
  eng.applyAction({ type: 'move', x: 4, y: 0, tx: 4, ty: 1 });   // Kxe2
  const r = eng.result();
  assert.ok(r);
  assert.equal(r.reason, 'insufficient material');
});

test('threefold repetition draws', () => {
  const eng = game('4k3/8/8/8/8/8/8/R3K3 w - - 0 1');
  // Shuffle both rooks/kings back and forth until a position recurs.
  const cycle = [
    [{ x: 0, y: 0, tx: 0, ty: 1 }, 0], [{ x: 4, y: 7, tx: 4, ty: 6 }, 1],
    [{ x: 0, y: 1, tx: 0, ty: 0 }, 0], [{ x: 4, y: 6, tx: 4, ty: 7 }, 1],
  ];
  for (let i = 0; i < 3 && !eng.isOver(); i++) {
    for (const [m, actor] of cycle) {
      if (eng.isOver()) break;
      eng.applyAction({ type: 'move', ...m }, actor);
    }
  }
  const r = eng.result();
  assert.ok(r, 'the game ended');
  assert.equal(r.reason, 'threefold repetition');
});

/* ---------- engine integration ---------- */

test('the engine refuses an illegal chess move', () => {
  const eng = game();
  assert.throws(() => eng.applyAction({ type: 'move', x: 4, y: 1, tx: 4, ty: 5 }), /Illegal action/);
});

test('a player cannot move on the opponent\u2019s turn', () => {
  const eng = game();
  assert.throws(() => eng.applyAction({ type: 'move', x: 4, y: 6, tx: 4, ty: 4 }, 1), /Illegal action/);
});

test('undo restores a captured piece', () => {
  const eng = game('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1');
  const before = eng.fingerprint();
  eng.applyAction({ type: 'move', x: 4, y: 3, tx: 3, ty: 4 });
  assert.equal(eng.state.board['3,4'].o, 0);
  eng.undo();
  assert.equal(eng.fingerprint(), before);
  assert.equal(eng.state.board['3,4'].o, 1, 'the black pawn is back');
});

test('a chess game replays to the same fingerprint', () => {
  const setup = { players: PLAYERS, config: {} };
  const actions = [
    { action: { type: 'move', x: 4, y: 1, tx: 4, ty: 3, double: true }, actorId: 0 },
    { action: { type: 'move', x: 4, y: 6, tx: 4, ty: 4, double: true }, actorId: 1 },
    { action: { type: 'move', x: 6, y: 0, tx: 5, ty: 2 }, actorId: 0 },
  ];
  const a = Engine.replay(chess, setup, actions);
  const b = Engine.replay(chess, setup, actions);
  assert.equal(a.fingerprint(), b.fingerprint());
  assert.equal(a.state.cur, 1);
});

test('scoping to one square narrows the move list', () => {
  const eng = game();
  const knight = eng.legalActions(0, { from: { x: 1, y: 0 } });
  assert.equal(knight.length, 2, 'the b1 knight has two moves at the start');
  assert.ok(knight.every(m => m.x === 1 && m.y === 0));
});

test('describeCell reports pieces the renderer can draw', () => {
  const eng = game();
  const cell = chess.describeCell(eng.state, 4, 0);
  assert.equal(cell.label, 'KING');
  assert.equal(cell.ownerId, 0);
  assert.ok(cell.classes.includes('white'));
  assert.equal(chess.describeCell(eng.state, 4, 4), null, 'empty ground is null');
});

test('the board reports finite bounds', () => {
  assert.deepEqual(chess.bounds(), { x0: 0, y0: 0, x1: 7, y1: 7 });
});

test('square naming matches algebraic notation', () => {
  assert.equal(sq(0, 0), 'a1');
  assert.equal(sq(7, 7), 'h8');
  assert.equal(sq(4, 3), 'e4');
});

test('check is reported without ending the game', () => {
  const eng = game('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  eng.applyAction({ type: 'move', x: 7, y: 0, tx: 7, ty: 7 });
  assert.ok(inCheck(eng.state, 1), 'black is in check');
  assert.equal(eng.result(), null, 'but not mated');
  assert.ok(eng.legalActions(1).length > 0);
});
