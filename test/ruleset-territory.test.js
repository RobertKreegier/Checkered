import test from 'node:test';
import assert from 'node:assert/strict';

import { Engine } from '../src/engine.js';
import territory from '../rulesets/territory.js';

const { K, at, tier } = territory.helpers;

/* ---------- fixtures ---------- */

const PLAYERS = [
  { name: 'Vermilion', unit: '#E2574C', armory: '#F2C14E' },
  { name: 'Cobalt', unit: '#3E8FD0', armory: '#8FD8E8' },
];

/** A game seated and ready, still in the placement phase. */
function seated(config = {}) {
  return new Engine(territory, {
    // Scatter off by default so tests see a board they fully control.
    config: { scatterStacks: 0, scatterCaches: 0, ...config },
    players: PLAYERS,
    seed: 42,
  });
}

/** Both camps placed, play under way. */
function started(config = {}) {
  const eng = seated(config);
  eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
  eng.applyAction({ type: 'place', x: 10, y: 0 }, 1);
  return eng;
}

/** Drop a board in wholesale, for testing one rule in isolation. */
function setBoard(eng, cells) {
  eng.state.board = {};
  for (const [k, v] of Object.entries(cells)) eng.state.board[k] = { ...v };
}

/* ---------- placement ---------- */

test('camps must respect the minimum spacing', () => {
  const eng = seated();
  eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
  assert.equal(eng.isLegal({ type: 'place', x: 2, y: 0 }, 1), false, 'too close');
  assert.equal(eng.isLegal({ type: 'place', x: 10, y: 0 }, 1), true);
});

test('placing the last camp starts production for the first player', () => {
  const eng = started();
  assert.equal(eng.state.phase, 'production');
  assert.equal(eng.state.cur, 0);
  assert.equal(at(eng.state, 0, 0).u, 8);
});

test('a starting camp of 8 is a town, and tiers read off the config', () => {
  const s = started().state;
  assert.equal(tier(s, 1), 'pawn');
  assert.equal(tier(s, 2), 'knight');
  assert.equal(tier(s, 4), 'camp');
  assert.equal(tier(s, 8), 'town');
});

/* ---------- production ---------- */

test('a town gets production equal to its unit chips', () => {
  const eng = started();
  assert.equal(eng.state.budget[K(0, 0)], 8);
});

test('production spends budget and places the product', () => {
  const eng = started();
  eng.applyAction({ type: 'produce', x: 0, y: 0, tx: 0, ty: 1, product: 'pawn' });
  assert.equal(eng.state.budget[K(0, 0)], 4);
  assert.equal(at(eng.state, 0, 1).u, 1);
  assert.equal(at(eng.state, 0, 1).o, 0);
});

test('armory may only be produced onto a stack you already hold', () => {
  const eng = started();
  assert.equal(eng.isLegal({ type: 'produce', x: 0, y: 0, tx: 0, ty: 0, product: 'armory' }), true);
  assert.equal(eng.isLegal({ type: 'produce', x: 0, y: 0, tx: 0, ty: 1, product: 'armory' }), false,
    'bare ground cannot hold armory');
});

test('production cannot be afforded past the budget', () => {
  const eng = started();
  eng.applyAction({ type: 'produce', x: 0, y: 0, tx: 0, ty: 0, product: 'knight' });
  assert.equal(eng.state.budget[K(0, 0)], 0);
  assert.equal(eng.isLegal({ type: 'produce', x: 0, y: 0, tx: 0, ty: 0, product: 'armory' }), false);
});

test('unspent production is banked into the stack that earned it', () => {
  const eng = started();
  eng.applyAction({ type: 'produce', x: 0, y: 0, tx: 0, ty: 1, product: 'pawn' }); // 8 -> 4
  eng.applyAction({ type: 'endProduction' });
  // 4 points left buys a pawn, banked onto the producing stack.
  assert.equal(at(eng.state, 0, 0).u, 9);
  assert.equal(eng.state.phase, 'move');
});

test('a pawn produces nothing', () => {
  const eng = started();
  eng.applyAction({ type: 'produce', x: 0, y: 0, tx: 0, ty: 1, product: 'pawn' });
  assert.equal(eng.state.budget[K(0, 1)], undefined);
});

/* ---------- moves ---------- */

test('moves equal squares held when the move step opens', () => {
  const eng = started();
  eng.applyAction({ type: 'produce', x: 0, y: 0, tx: 0, ty: 1, product: 'pawn' });
  eng.applyAction({ type: 'endProduction' });
  assert.equal(eng.state.territory, 2);
  assert.equal(eng.state.moves, 2);
});

test('moving costs one per chip, armory included', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 1 }, '1,0': { o: 0, u: 2, a: 0 } });
  eng.state.moves = 10;
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 2, nA: 1, spend: 0 });
  assert.equal(eng.state.moves, 7, 'three chips, three moves');
  assert.equal(at(eng.state, 1, 0).u, 4);
  assert.equal(at(eng.state, 1, 0).a, 1);
});

test('a lone chip may not walk away from the stack that was holding it up', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  // A lone pawn out on its own: stepping anywhere leaves it unsupported,
  // because the square it came from empties behind it.
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 0 }, '5,5': { o: 0, u: 1, a: 0 } });
  eng.state.moves = 8;
  assert.equal(eng.isLegal({ type: 'move', x: 5, y: 5, tx: 6, ty: 5, nU: 1, nA: 0, spend: 0 }), false);
});

test('a lone chip may step off a stack that stays behind to support it', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 0 } });
  eng.state.moves = 8;
  // 3 chips remain at 0,0, which is adjacent to the landing square.
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 1, nA: 0, spend: 0 }), true);
  // Two chips make a knight, which supports itself regardless.
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 2, nA: 0, spend: 0 }), true);
});

test('a lone chip may step onto ground a neighbouring stack already holds', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 0 }, '2,0': { o: 0, u: 2, a: 0 } });
  eng.state.moves = 8;
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 1, nA: 0, spend: 0 }), true,
    'the knight at 2,0 supports the landing square');
});

test('armory alone can only be passed to your own occupied stack', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 2 }, '1,0': { o: 0, u: 1, a: 0 } });
  eng.state.moves = 6;
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 0, nA: 1, spend: 0 }), true);
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 0, ty: 1, nU: 0, nA: 1, spend: 0 }), false,
    'armory cannot sit on bare ground');
});

test('the last camp is protected from being dismantled', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 0 }, '1,0': { o: 0, u: 1, a: 0 } });
  eng.state.moves = 6;
  // Taking a chip off the only camp would drop it below campSize.
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 1, nA: 0, spend: 0 }), false);
  // Moving the whole camp keeps a camp on the board, so it is allowed.
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 4, nA: 0, spend: 0 }), true);
});

/* ---------- battle ---------- */

test('attackers die and each lands one hit', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 5, a: 0 }, '1,0': { o: 1, u: 3, a: 0 } });
  eng.state.moves = 8;
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 2, nA: 0, spend: 0 });
  assert.equal(at(eng.state, 0, 0).u, 3, 'two attackers lost');
  assert.equal(at(eng.state, 1, 0).u, 1, 'two defenders killed');
});

test('defending armory absorbs hits before units fall', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 5, a: 0 }, '1,0': { o: 1, u: 3, a: 2 } });
  eng.state.moves = 8;
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 3, nA: 0, spend: 0 });
  const def = at(eng.state, 1, 0);
  assert.equal(def.a, 0, 'both armory chips absorbed a hit');
  assert.equal(def.u, 2, 'only the third hit killed a unit');
});

test('spent armory adds hits to an attack', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 5, a: 2 }, '1,0': { o: 1, u: 4, a: 0 } });
  eng.state.moves = 8;
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 1, nA: 0, spend: 2 });
  assert.equal(at(eng.state, 1, 0).u, 1, '1 attacker + 2 spent armory = 3 hits');
  assert.equal(at(eng.state, 0, 0).a, 0, 'the spent armory is gone');
});

test('thrown armory deals its own damage and is consumed', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 2 }, '1,0': { o: 1, u: 5, a: 0 } });
  eng.state.moves = 8;
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 0, nA: 1, spend: 0 });
  assert.equal(at(eng.state, 1, 0).u, 3, 'one thrown chip is two hits');
  assert.equal(at(eng.state, 0, 0).a, 1);
  assert.equal(at(eng.state, 0, 0).u, 4, 'no units were risked');
});

test('a stack carrying armory cannot attack', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 2 }, '1,0': { o: 1, u: 3, a: 0 } });
  eng.state.moves = 8;
  assert.equal(eng.isLegal({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 2, nA: 1, spend: 0 }), false);
});

test('blocking armory is spent before any unit dies', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 6, a: 0 }, '1,0': { o: 1, u: 1, a: 3 } });
  eng.state.moves = 8;
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 4, nA: 0, spend: 0 });
  // Three hits absorbed, the fourth kills the last unit — nothing is
  // left to strand, so the square clears entirely.
  assert.equal(at(eng.state, 1, 0), null);
});

test('a wiped stack leaves its armory loose when armory does not block', () => {
  const eng = started({ lockLastCamp: false, captureArmory: false, defenderBlocks: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 6, a: 0 }, '1,0': { o: 1, u: 1, a: 3 } });
  eng.state.moves = 8;
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 4, nA: 0, spend: 0 });
  const cell = at(eng.state, 1, 0);
  assert.equal(cell.o, null, 'ownerless');
  assert.equal(cell.u, 0);
  assert.equal(cell.a, 3, 'the armory outlived its owner');
});

/* ---------- the conversion triangle ---------- */

test('burning armory buys moves, forging spends them', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 1 } });
  eng.state.moves = 3;
  eng.applyAction({ type: 'burn', x: 0, y: 0 });
  assert.equal(eng.state.moves, 4);
  assert.equal(at(eng.state, 0, 0).a, 0);
  eng.applyAction({ type: 'forge', x: 0, y: 0 });
  assert.equal(eng.state.moves, 3);
  assert.equal(at(eng.state, 0, 0).a, 1);
});

test('two armory melt into one unit chip', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 2 } });
  eng.state.moves = 4;
  eng.applyAction({ type: 'melt', x: 0, y: 0 });
  assert.equal(at(eng.state, 0, 0).u, 5);
  assert.equal(at(eng.state, 0, 0).a, 0);
  assert.equal(eng.isLegal({ type: 'melt', x: 0, y: 0 }), false, 'nothing left to melt');
});

/* ---------- end of play ---------- */

test('an unsupported pawn with nobody beside it goes neutral', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 0 }, '6,6': { o: 0, u: 1, a: 0 } });
  eng.state.moves = 0;
  eng.applyAction({ type: 'endTurn' });
  assert.equal(at(eng.state, 6, 6).o, null);
});

test('a stranded pawn defects to the rival standing beside it', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, {
    '0,0': { o: 0, u: 4, a: 0 },
    '6,6': { o: 0, u: 1, a: 0 },     // ours, cut off
    '7,6': { o: 1, u: 3, a: 0 },     // theirs, adjacent
  });
  eng.state.moves = 0;
  eng.applyAction({ type: 'endTurn' });
  assert.equal(at(eng.state, 6, 6).o, 1, 'the pawn changed hands');
});

test('a neutral stack joins whoever ends a play beside it', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, {
    '0,0': { o: 0, u: 4, a: 0 },
    '1,0': { o: null, u: 3, a: 0 },
  });
  eng.state.moves = 0;
  eng.applyAction({ type: 'endTurn' });
  assert.equal(at(eng.state, 1, 0).o, 0);
});

test('losing your last camp ends your game', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 2, a: 0 }, '10,0': { o: 1, u: 8, a: 0 } });
  eng.state.moves = 0;
  eng.applyAction({ type: 'endTurn' });
  assert.equal(eng.state.players[0].alive, false);
  const result = eng.result();
  assert.ok(result, 'the game is over');
  assert.equal(result.winnerId, 1);
});

test('unspent moves spill onto the ground as loose armory', () => {
  const eng = started();
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 8, a: 0 } });
  eng.state.moves = 6;
  eng.applyAction({ type: 'endTurn' });
  const loose = Object.values(eng.state.board).filter(c => c.o === null && c.u === 0);
  assert.equal(loose.reduce((n, c) => n + c.a, 0), 3, '6 moves at 2 each = 3 chips');
});

/* ---------- determinism, the multiplayer prerequisite ---------- */

test('the same seed scatters the same neutrals', () => {
  const build = () => {
    const eng = new Engine(territory, {
      config: { scatterStacks: 4, scatterCaches: 2 }, players: PLAYERS, seed: 777,
    });
    eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
    eng.applyAction({ type: 'place', x: 10, y: 0 }, 1);
    return eng;
  };
  assert.equal(build().fingerprint(), build().fingerprint());
});

test('different seeds scatter differently', () => {
  const build = seed => {
    const eng = new Engine(territory, {
      config: { scatterStacks: 6 }, players: PLAYERS, seed,
    });
    eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
    eng.applyAction({ type: 'place', x: 10, y: 0 }, 1);
    return eng.fingerprint();
  };
  assert.notEqual(build(1), build(2));
});

test('a full game replays to an identical fingerprint', () => {
  const actions = [];
  const setup = { config: { scatterStacks: 3 }, players: PLAYERS, seed: 5150 };
  const play = record => {
    const eng = new Engine(territory, setup);
    const run = (action, actorId) => {
      eng.applyAction(action, actorId);
      if (record) actions.push({ action, actorId });
    };
    run({ type: 'place', x: 0, y: 0 }, 0);
    run({ type: 'place', x: 10, y: 0 }, 1);
    run({ type: 'produce', x: 0, y: 0, tx: 0, ty: 1, product: 'pawn' }, 0);
    run({ type: 'endProduction' }, 0);
    run({ type: 'endTurn' }, 0);
    return eng;
  };
  const first = play(true).fingerprint();
  const replayed = Engine.replay(territory, setup, actions);
  assert.equal(replayed.fingerprint(), first);
});

test('undo through a battle restores the dead', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 5, a: 0 }, '1,0': { o: 1, u: 3, a: 0 } });
  eng.state.moves = 8;
  const before = eng.fingerprint();
  eng.applyAction({ type: 'move', x: 0, y: 0, tx: 1, ty: 0, nU: 2, nA: 0, spend: 0 });
  eng.undo();
  assert.equal(eng.fingerprint(), before);
  assert.equal(at(eng.state, 1, 0).u, 3);
});

/* ---------- action enumeration, which the AI will lean on ---------- */

test('legalActions offers real, applicable actions', () => {
  const eng = started();
  const actions = eng.legalActions(0);
  assert.ok(actions.length > 1);
  for (const a of actions) {
    assert.equal(eng.isLegal(a, 0), true, `isLegal disagreed with legalActions on ${JSON.stringify(a)}`);
  }
});

test('legalActions honours a from-scope hint', () => {
  const eng = started();
  eng.applyAction({ type: 'produce', x: 0, y: 0, tx: 0, ty: 0, product: 'armory' });
  const scoped = eng.legalActions(0, { from: { x: 0, y: 0 } });
  assert.ok(scoped.every(a => a.type === 'endProduction' || (a.x === 0 && a.y === 0)));
});

test('the move phase enumerates every chip split', () => {
  const eng = started({ lockLastCamp: false });
  eng.applyAction({ type: 'endProduction' });
  setBoard(eng, { '0,0': { o: 0, u: 4, a: 1 }, '1,0': { o: 0, u: 2, a: 0 } });
  eng.state.moves = 6;
  const moves = eng.legalActions(0).filter(a => a.type === 'move' && a.tx === 1 && a.ty === 0);
  const splits = new Set(moves.map(a => `${a.nU}/${a.nA}`));
  assert.ok(splits.has('1/0'));
  assert.ok(splits.has('4/1'), 'the whole stack is one of the options');
});

test('no actions are offered once the game is over', () => {
  const eng = started();
  eng.state.phase = 'over';
  eng.state.winner = 1;
  assert.deepEqual(eng.legalActions(0), []);
  assert.throws(() => eng.applyAction({ type: 'endTurn' }), /already over/);
});

/* ---------- the ground is laid before anyone stands on it ---------- */

test('neutral stacks are on the board before the first camp is placed', () => {
  const eng = new Engine(territory, {
    players: [{ name: 'A' }, { name: 'B' }],
    config: { scatterStacks: 4, scatterCaches: 2 },
    seed: 12,
  });
  assert.equal(eng.state.phase, 'place');
  const cells = territory.occupiedCells(eng.state);
  assert.ok(cells.length > 0,
    'players should be able to see the resources before choosing a start');
  for (const { x, y } of cells) {
    assert.equal(territory.describeCell(eng.state, x, y).ownerId, null,
      'everything on an unplaced board belongs to nobody');
  }
});

test('a camp may be pitched right beside a neutral stack', () => {
  // Spacing is about keeping rulers apart. Measuring it against every
  // occupied square would fence players away from exactly the ground
  // they are meant to be competing for.
  const eng = new Engine(territory, {
    players: [{ name: 'A' }, { name: 'B' }],
    config: { scatterStacks: 4 },
    seed: 12,
  });
  const n = territory.occupiedCells(eng.state)[0];
  const beside = { type: 'place', x: n.x + 1, y: n.y };
  assert.ok(eng.isLegal(beside, 0), 'a neutral should not block a start next to it');
  assert.doesNotThrow(() => eng.applyAction(beside, 0));
});

test('camps must still stand clear of one another', () => {
  const eng = new Engine(territory, {
    players: [{ name: 'A' }, { name: 'B' }],
    config: { scatterStacks: 2, campSpacing: 4 },
    seed: 3,
  });
  eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
  for (const a of eng.legalActions(1)) {
    const gap = Math.max(Math.abs(a.x), Math.abs(a.y));
    assert.ok(gap >= 4, `${a.x},${a.y} is only ${gap} from the first camp`);
  }
});

test('a start cannot be pitched on top of a neutral stack', () => {
  const eng = new Engine(territory, {
    players: [{ name: 'A' }, { name: 'B' }],
    config: { scatterStacks: 4 },
    seed: 12,
  });
  const n = territory.occupiedCells(eng.state)[0];
  assert.ok(!eng.isLegal({ type: 'place', x: n.x, y: n.y }, 0),
    'the square is taken, even though nobody owns it');
});

test('the opening scatter is reported once, in the record', () => {
  const eng = new Engine(territory, {
    players: [{ name: 'A' }, { name: 'B' }],
    config: { scatterStacks: 3 },
    seed: 7,
  });
  eng.applyAction(eng.legalActions(0)[0], 0);
  const notes = eng.log.filter(e => /ground holds/.test(e.text));
  assert.equal(notes.length, 1, 'the scatter should be announced exactly once');
  eng.applyAction(eng.legalActions(1)[0], 1);
  assert.equal(eng.log.filter(e => /ground holds/.test(e.text)).length, 1,
    'and not repeated on every action');
});

test('the same seed lays the same ground', () => {
  const make = () => new Engine(territory, {
    players: [{ name: 'A' }, { name: 'B' }],
    config: { scatterStacks: 4, scatterCaches: 2 },
    seed: 99,
  }).fingerprint();
  assert.equal(make(), make(), 'scattering at creation must stay deterministic');
});
