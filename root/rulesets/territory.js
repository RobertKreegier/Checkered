/* territory.js — Territory, as a ruleset.
 *
 * A game of expansion, economy, and war on an infinite grid. Ported from
 * the original single-file build; the rules are unchanged, but every
 * mutation now goes through applyAction() and every random draw goes
 * through the engine's seeded rng.
 *
 * State shape:
 *   phase     "place" | "production" | "move" | "over"
 *   board     { "x,y": {o, u, a} }   o = actor index, or null for nobody's
 *   budget    { "x,y": points left to spend this production step }
 *   players   [{name, unit, armory, alive}]
 *   cur       whose play it is
 *   moves     moves left in the current move step
 *   territory squares held when the move step began
 */

/* ---------- coordinates ---------- */
const K = (x, y) => x + ',' + y;
const un = k => k.split(',').map(Number);

const NB4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NB8 = NB4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);

/* ---------- config ---------- */
const config = {
  diag: true,
  knightSize: 2, campSize: 4, townSize: 8,
  startCamp: 8, campSpacing: 4,
  prodFactor: 1, costArmory: 2, costPawn: 4, costKnight: 8,
  moveFactor: 1, moveBonus: 0,
  attackDamage: 1, spendDamage: 1, defenderBlocks: true, attackerDies: true,
  armoryStrike: 2,
  pawnSupport: true, lockLastCamp: true, autoEndProduction: true,
  autoEndMove: true, captureArmory: false,
  scatterCaches: 0, cacheMax: 3, scatterStacks: 6, stackMax: 5,
  scatterRadius: 12, scatterClear: 4, recruitNeutral: true, recruitAbandoned: true,
  burnArmory: 1, forgeCost: 1, spillCost: 2, meltCost: 2,
};

const configSpec = [
  ['Board', [
    ['diag', 'Diagonals count as touching', 'bool'],
    ['campSpacing', 'Minimum gap between starting camps', 'num'],
    ['startCamp', 'Unit chips in a starting camp', 'num'],
  ]],
  ['Stack sizes', [
    ['knightSize', 'Chips to make a knight', 'num'],
    ['campSize', 'Chips to make a camp', 'num'],
    ['townSize', 'Chips to make a town', 'num'],
  ]],
  ['Production', [
    ['prodFactor', 'Production points per unit chip', 'num'],
    ['costArmory', 'Cost of an armory chip', 'num'],
    ['costPawn', 'Cost of a pawn', 'num'],
    ['costKnight', 'Cost of a knight', 'num'],
    ['autoEndProduction', 'End the step when nothing can be produced', 'bool'],
    ['meltCost', 'Armory chips melted into one unit chip', 'num'],
  ]],
  ['Moves', [
    ['moveFactor', 'Moves per square held', 'num'],
    ['moveBonus', 'Extra moves each play', 'num'],
    ['autoEndMove', 'End the play when the last move is spent', 'bool'],
    ['burnArmory', 'Moves gained per armory chip burned', 'num'],
    ['forgeCost', 'Moves spent to forge one armory chip', 'num'],
    ['spillCost', 'Moves per armory chip spilled at the end of a play', 'num'],
  ]],
  ['Battle', [
    ['attackDamage', 'Hits per attacking unit chip', 'num'],
    ['spendDamage', 'Hits per armory spent in a strike', 'num'],
    ['armoryStrike', 'Hits when armory is thrown at a stack', 'num'],
    ['defenderBlocks', 'Defending armory absorbs hits first', 'bool'],
    ['attackerDies', 'Attacking chips die on impact', 'bool'],
    ['captureArmory', 'Wiping a stack captures its armory', 'bool'],
  ]],
  ['Neutrals on the board', [
    ['scatterCaches', 'Loose armory piles per player', 'num'],
    ['cacheMax', 'Most chips in a pile', 'num'],
    ['scatterStacks', 'Neutral stacks per player', 'num'],
    ['stackMax', 'Most unit chips in a neutral stack', 'num'],
    ['scatterRadius', 'Scatter no further than this from a start', 'num'],
    ['scatterClear', 'Keep this clear around every start', 'num'],
    ['recruitNeutral', 'Neutral stacks join whoever supports them', 'bool'],
  ]],
  ['Survival', [
    ['pawnSupport', 'Unsupported pawns die', 'bool'],
    ['recruitAbandoned', 'Abandoned pawns defect to whoever supports them', 'bool'],
    ['lockLastCamp', 'Block moves that would break your last camp', 'bool'],
  ]],
];

/* ---------- board helpers, all taking state explicitly ---------- */
const cfg = s => s.config;
const at = (s, x, y) => s.board[K(x, y)] || null;
const isCache = t => !!t && t.o === null && t.u === 0;
const foeAt = (s, t, me) => !!t && t.o !== null && t.o !== me;

function nbs(s, x, y) {
  return (cfg(s).diag ? NB8 : NB4).map(([dx, dy]) => [x + dx, y + dy]);
}

function tier(s, u) {
  const c = cfg(s);
  if (u <= 0) return 'empty';
  if (u < c.knightSize) return 'pawn';
  if (u < c.campSize) return 'knight';
  if (u < c.townSize) return 'camp';
  return 'town';
}

function occupied(s, pi) {
  let n = 0;
  for (const st of Object.values(s.board)) if (st.o === pi) n++;
  return n;
}

function hasCamp(s, pi) {
  for (const st of Object.values(s.board)) {
    if (st.o === pi && st.u >= cfg(s).campSize) return true;
  }
  return false;
}

function campCount(s, pi) {
  let n = 0;
  for (const st of Object.values(s.board)) {
    if (st.o === pi && st.u >= cfg(s).campSize) n++;
  }
  return n;
}

/** Camps the mover would still hold after shifting n unit chips. */
function campsAfter(s, sx, sy, tx, ty, n, toEnemy) {
  const me = s.cur, c = cfg(s);
  let count = 0;
  const sk = K(sx, sy), tk = K(tx, ty);
  for (const [k, st] of Object.entries(s.board)) {
    if (st.o !== me) continue;
    let u = st.u;
    if (k === sk) u -= n;
    if (k === tk && !toEnemy) u += n;
    if (u >= c.campSize) count++;
  }
  if (!toEnemy) {
    const tgt = s.board[tk];
    if ((!tgt || tgt.o === null) && n + (tgt ? tgt.u : 0) >= c.campSize) count++;
  }
  return count;
}

/** Leave a cache behind, or clear the square, when a stack loses its units. */
function strand(s, k, st, log, msg) {
  if (st.a > 0) {
    st.o = null; st.u = 0;
    if (msg) log.push(msg);
  } else {
    delete s.board[k];
  }
}

const COST = (s, p) => ({
  armory: cfg(s).costArmory,
  pawn: cfg(s).costPawn,
  knight: cfg(s).costKnight,
}[p]);

/* ---------- legality: production ---------- */
function prodTargets(s, x, y, prod) {
  const out = [], me = s.cur;
  if ((s.budget[K(x, y)] || 0) < COST(s, prod)) return out;
  if (COST(s, prod) <= 0) return out;
  for (const [i, j] of [[x, y]].concat(nbs(s, x, y))) {
    const t = at(s, i, j);
    if (prod === 'armory') {
      if (t && t.o === me && t.u >= 1) out.push([i, j]);
    } else if (!t || t.o === me || isCache(t)) {
      out.push([i, j]);
    }
  }
  return out;
}

function anyProductionLeft(s) {
  for (const [k, bud] of Object.entries(s.budget)) {
    if (bud <= 0) continue;
    const [x, y] = un(k);
    for (const p of ['armory', 'pawn', 'knight']) {
      if (prodTargets(s, x, y, p).length) return true;
    }
  }
  return false;
}

/* ---------- legality: movement ----------
 * Pure version of the old legalTargets(): the chip split arrives as
 * arguments instead of being read out of UI selection state.
 */
function moveTargets(s, x, y, nU, nA) {
  const out = [], me = s.cur, c = cfg(s);
  const src = at(s, x, y);
  if (!src || src.o !== me) return out;
  const cost = nU + nA;
  if (cost < 1 || cost > s.moves || src.u < nU || src.a < nA) return out;

  const guard = c.lockLastCamp && campCount(s, me) > 0;

  for (const [i, j] of nbs(s, x, y)) {
    const t = at(s, i, j);
    const foe = foeAt(s, t, me);

    if (foe) {
      // A strike is either unit chips or thrown armory, never a carried stack.
      if (nU > 0 && nA > 0) continue;
      if (nU > 0 && guard && campsAfter(s, x, y, i, j, nU, true) === 0) continue;
      out.push([i, j]);
      continue;
    }

    if (nU > 0) {
      if (guard && campsAfter(s, x, y, i, j, nU, false) === 0) continue;
      // A lone chip may only step onto ground something else already holds.
      if (c.pawnSupport) {
        const landing = (t && t.o === me ? t.u : 0) + nU;
        if (landing === 1) {
          const leftBehind = src.u - nU;
          const held = nbs(s, i, j).some(([a, b]) => {
            if (a === x && b === y) return leftBehind >= 1;
            const q = at(s, a, b);
            return q && q.o === me && q.u >= 1;
          });
          if (!held) continue;
        }
      }
      out.push([i, j]);
    } else if (t && t.o === me && t.u >= 1) {
      out.push([i, j]);      // armory passed to your own stack
    }
  }
  return out;
}

/* ---------- placement ---------- */
function canPlace(s, x, y) {
  if (at(s, x, y)) return false;                 // something already stands here
  // Spacing is about keeping rulers apart, so it is measured against
  // the other camps only. Measuring it against everything on the board
  // would fence players away from the neutral stacks, when choosing a
  // start near the resources you want is the whole point of placing
  // after the ground has been scattered.
  const gap = cfg(s).campSpacing;
  for (const [sx, sy] of s.starts) {
    if (Math.max(Math.abs(sx - x), Math.abs(sy - y)) < gap) return false;
  }
  return true;
}

/* ---------- neutrals ---------- */
/**
 * Strew the opening ground with neutral stacks and loose armory.
 *
 * This runs before anyone places a camp, so the players can see what is
 * out there and choose a start with the resources in mind — where to sit
 * becomes a real decision rather than a blind one. It also means the
 * scatter can't be anchored on the camps, because there aren't any yet;
 * it spreads around the origin instead, and `scatterClear` keeps the
 * middle open so the board doesn't begin choked at its centre.
 */
function scatterNeutrals(s, rng, log) {
  const c = cfg(s);
  const R = c.scatterRadius, clear = c.scatterClear;
  if (R <= 0) return;

  const far = (x, y) => Math.max(Math.abs(x), Math.abs(y)) >= clear;
  const near = (x, y) => Math.max(Math.abs(x), Math.abs(y)) <= R;

  const spot = () => {
    for (let tries = 0; tries < 160; tries++) {
      const x = rng.range(-R, R);
      const y = rng.range(-R, R);
      if (s.board[K(x, y)]) continue;
      if (!far(x, y) || !near(x, y)) continue;
      return [x, y];
    }
    return null;
  };

  // Scaled by how many are playing, as before, so a four-player board is
  // richer than a duel rather than the same ground split four ways.
  const n = Math.max(1, s.players.length);
  let caches = 0, stacks = 0;
  for (let i = 0; i < c.scatterCaches * n && c.cacheMax > 0; i++) {
    const p = spot(); if (!p) break;
    s.board[K(p[0], p[1])] = { o: null, u: 0, a: rng.range(1, c.cacheMax) };
    caches++;
  }
  for (let i = 0; i < c.scatterStacks * n && c.stackMax > 0; i++) {
    const p = spot(); if (!p) break;
    s.board[K(p[0], p[1])] = { o: null, u: rng.range(1, c.stackMax), a: 0 };
    stacks++;
  }
  if (caches || stacks) {
    // createInitialState has nowhere to write a log entry, so the note
    // is held on the state and pushed by the first action taken.
    s.openingNote = `The ground holds ${stacks} neutral stack${stacks === 1 ? '' : 's'} `
      + `and ${caches} loose armory pile${caches === 1 ? '' : 's'} — choose your ground with them in mind.`;
  }
}

/* ---------- phase transitions ---------- */
function startProduction(s, log) {
  s.phase = 'production';
  s.budget = {};
  const c = cfg(s);
  for (const [k, st] of Object.entries(s.board)) {
    if (st.o === s.cur && st.u >= c.knightSize) {
      s.budget[k] = Math.floor(st.u * c.prodFactor);
    }
  }
  log.push(`— ${s.players[s.cur].name}'s play begins —`);
  if (c.autoEndProduction && !anyProductionLeft(s)) {
    log.push('Nothing to produce this step.');
    finishProduction(s, log);
  }
}

/** Bank unspent points into the stack that earned them. */
function autoProduce(s, log) {
  const c = cfg(s);
  for (const [k, bud0] of Object.entries({ ...s.budget })) {
    const st = s.board[k];
    if (!st || st.o !== s.cur) continue;
    let bud = bud0;
    const added = { knight: 0, pawn: 0, armory: 0 };
    let guard = 0;
    while (guard++ < 200) {
      let p = null;
      if (bud >= c.costKnight && c.costKnight > 0) p = 'knight';
      else if (bud >= c.costPawn && c.costPawn > 0) p = 'pawn';
      else if (bud >= c.costArmory && c.costArmory > 0) p = 'armory';
      if (!p) break;
      bud -= COST(s, p); added[p]++;
      if (p === 'knight') st.u += c.knightSize;
      else if (p === 'pawn') st.u += 1;
      else st.a += 1;
    }
    s.budget[k] = bud;
    const parts = Object.entries(added).filter(([, n]) => n).map(([n, q]) => `${q} ${n}${q > 1 ? 's' : ''}`);
    if (parts.length) {
      const [x, y] = un(k);
      log.push(`Unspent production at ${x},${y} banked as ${parts.join(', ')}.`);
    }
  }
}

function finishProduction(s, log) {
  if (s.phase !== 'production') return;
  autoProduce(s, log);
  const c = cfg(s);
  s.phase = 'move';
  s.territory = occupied(s, s.cur);
  s.moves = Math.floor(s.territory * c.moveFactor) + c.moveBonus;
  log.push(`${s.players[s.cur].name} holds ${s.territory} square${s.territory === 1 ? '' : 's'} — ${s.moves} moves.`);
  if (c.autoEndMove && s.moves <= 0 && !canBurnAnywhere(s)) {
    log.push('No moves to make.');
    finishTurn(s, log, null);
  }
}

function canBurnAnywhere(s) {
  if (cfg(s).burnArmory <= 0) return false;
  for (const st of Object.values(s.board)) {
    if (st.o === s.cur && st.a >= 1) return true;
  }
  return false;
}

/** Leftover moves fall onto the ground near your own squares as loose armory. */
function spillMoves(s, rng, log) {
  const c = cfg(s);
  if (c.spillCost <= 0 || s.moves < c.spillCost) return;
  const chips = Math.floor(s.moves / c.spillCost);
  const mine = Object.entries(s.board).filter(([, st]) => st.o === s.cur).map(([k]) => un(k));
  if (!mine.length) return;
  let placed = 0;
  for (let i = 0; i < chips; i++) {
    for (let tries = 0; tries < 60; tries++) {
      const [ox, oy] = mine[rng.int(mine.length)];
      const x = ox + rng.range(-3, 3), y = oy + rng.range(-3, 3);
      const cell = at(s, x, y);
      if (cell && !(cell.o === null && cell.u === 0)) continue;
      if (cell) cell.a++;
      else s.board[K(x, y)] = { o: null, u: 0, a: 1 };
      placed++; break;
    }
  }
  if (placed) {
    log.push(`${s.moves} unspent move${s.moves === 1 ? '' : 's'} scattered as ${placed} loose armory chip${placed === 1 ? '' : 's'}.`);
  }
  s.moves = 0;
}

function finishTurn(s, log, rng) {
  const c = cfg(s);
  if (s.phase === 'move' && rng) spillMoves(s, rng, log);

  const heldBy = (x, y, pi) => nbs(s, x, y).some(([i, j]) => {
    const q = at(s, i, j);
    return q && q.o === pi && q.u >= 1;
  });

  // Neutral stacks join whoever is standing beside them.
  if (c.recruitNeutral) {
    for (const [k, st] of Object.entries(s.board)) {
      if (st.o !== null || st.u < 1) continue;
      const [x, y] = un(k);
      if (heldBy(x, y, s.cur)) {
        st.o = s.cur;
        log.push(`The neutral ${tier(s, st.u)} at ${x},${y} joined ${s.players[s.cur].name}.`);
      }
    }
  }

  // A rival's pawn, cut off from its own side, with you beside it.
  if (c.recruitAbandoned) {
    for (const [k, st] of Object.entries(s.board)) {
      if (st.o === null || st.o === s.cur || st.u !== 1) continue;
      const [x, y] = un(k);
      if (heldBy(x, y, st.o)) continue;
      if (!heldBy(x, y, s.cur)) continue;
      const from = s.players[st.o].name;
      st.o = s.cur;
      log.push(`${from}'s abandoned pawn at ${x},${y} came over to ${s.players[s.cur].name}.`);
    }
  }

  // Your own stranded pawns: taken in by a rival, else they go neutral.
  const doomed = [];
  for (const [k, st] of Object.entries(s.board)) {
    if (!c.pawnSupport || st.o !== s.cur || st.u !== 1) continue;
    const [x, y] = un(k);
    if (heldBy(x, y, s.cur)) continue;
    let taker = null;
    if (c.recruitAbandoned) {
      const backing = new Map();
      for (const [i, j] of nbs(s, x, y)) {
        const q = at(s, i, j);
        if (!q || q.o === null || q.o === s.cur || q.u < 1) continue;
        backing.set(q.o, (backing.get(q.o) || 0) + q.u);
      }
      for (const [pi, w] of backing) if (!taker || w > taker.w) taker = { pi, w };
    }
    if (taker) {
      st.o = taker.pi;
      log.push(`Your abandoned pawn at ${x},${y} went over to ${s.players[taker.pi].name}.`);
    } else doomed.push(k);
  }
  for (const k of doomed) {
    s.board[k].o = null;
    log.push(`Abandoned pawn at ${k} went neutral.`);
  }

  // Camp check for the active player.
  if (!hasCamp(s, s.cur)) {
    s.players[s.cur].alive = false;
    for (const [k, st] of Object.entries({ ...s.board })) {
      if (st.o === s.cur) strand(s, k, st, log, null);
    }
    log.push(`${s.players[s.cur].name} ended a play without a camp and is out.`);
  }

  // Victory.
  const left = s.players.filter(p => p.alive);
  if (left.length === 0) {
    s.phase = 'over'; s.winner = null;
    log.push('No camps remain.');
    return;
  }
  if (s.players.length > 1 && left.length === 1) {
    s.phase = 'over';
    s.winner = s.players.indexOf(left[0]);
    log.push(`${left[0].name} wins.`);
    return;
  }

  // Next player.
  let g = 0;
  do { s.cur = (s.cur + 1) % s.players.length; g++; }
  while (!s.players[s.cur].alive && g < 10);
  s.turnNo++;
  startProduction(s, log);
}

/* ---------- action application ---------- */
function doProduce(s, a, log) {
  const key = K(a.x, a.y);
  const c = cfg(s);
  s.budget[key] = (s.budget[key] || 0) - COST(s, a.product);
  let t = at(s, a.tx, a.ty);
  if (!t) { t = { o: s.cur, u: 0, a: 0 }; s.board[K(a.tx, a.ty)] = t; }
  if (isCache(t)) {
    t.o = s.cur;
    log.push(`${t.a} loose armory at ${a.tx},${a.ty} claimed.`);
  }
  if (a.product === 'armory') t.a += 1;
  if (a.product === 'pawn') t.u += 1;
  if (a.product === 'knight') t.u += c.knightSize;
  const src = at(s, a.x, a.y);
  log.push(`${s.players[s.cur].name} ${tier(s, src ? src.u : 0)} at ${a.x},${a.y} produced ${a.product} → ${a.tx},${a.ty}`);

  if (c.autoEndProduction && !anyProductionLeft(s)) {
    log.push('Nothing left to produce.');
    finishProduction(s, log);
  }
}

function doMove(s, a, rng, log) {
  const c = cfg(s);
  const sk = K(a.x, a.y), tk = K(a.tx, a.ty);
  const src = at(s, a.x, a.y);
  let t = at(s, a.tx, a.ty);
  const nU = a.nU, nA = a.nA;
  const foe = foeAt(s, t, s.cur);

  const strike = (target, dmg) => {
    let blocked = 0, killed = 0;
    while (dmg > 0 && target.u > 0) {
      if (c.defenderBlocks && target.a > 0) { target.a--; blocked++; }
      else { target.u--; killed++; }
      dmg--;
    }
    return { blocked, killed };
  };

  const wipeCheck = () => {
    if (t.u <= 0) {
      const owner = s.players[t.o].name;
      if (c.captureArmory && t.a > 0) {
        const loot = t.a;
        delete s.board[tk];
        const s2 = at(s, a.x, a.y);
        if (s2) s2.a += loot;
        log.push(`${owner}'s stack at ${a.tx},${a.ty} was wiped out — ${loot} armory captured.`);
      } else {
        log.push(`${owner}'s stack at ${a.tx},${a.ty} was wiped out.`);
        strand(s, tk, t, log, t.a > 0 ? `${t.a} armory left loose at ${a.tx},${a.ty}.` : null);
      }
    }
  };

  if (foe && nU === 0) {
    src.a -= nA; s.moves -= nA;
    const r = strike(t, nA * c.armoryStrike);
    log.push(`${s.players[s.cur].name} threw ${nA} armory at ${s.players[t.o].name} (${a.tx},${a.ty}) — ${r.killed} unit${r.killed === 1 ? '' : 's'} killed${r.blocked ? `, ${r.blocked} armory destroyed` : ''}.`);
    wipeCheck();
  } else if (nU === 0) {
    src.a -= nA; t.a += nA; s.moves -= nA;
    log.push(`${s.players[s.cur].name} passed ${nA} armory ${a.x},${a.y} → ${a.tx},${a.ty}`);
  } else if (foe) {
    const spend = Math.min(a.spend || 0, src.a);
    src.a -= spend;
    const r = strike(t, nU * c.attackDamage + spend * c.spendDamage);
    if (c.attackerDies) src.u -= nU;
    s.moves -= nU;
    let msg = `${s.players[s.cur].name} struck ${s.players[t.o].name} at ${a.tx},${a.ty}: ${nU} attacker${nU > 1 ? 's' : ''} ${c.attackerDies ? 'lost' : 'held'}`;
    if (spend) msg += `, ${spend} armory spent`;
    msg += ` — ${r.killed} unit${r.killed === 1 ? '' : 's'} killed`;
    if (r.blocked) msg += `, ${r.blocked} blocked by armory`;
    log.push(msg + '.');
    wipeCheck();
  } else {
    if (!t) { t = { o: s.cur, u: 0, a: 0 }; s.board[tk] = t; }
    const claim = isCache(t) ? t.a : 0;
    const absorb = t.o === null ? t.u : 0;
    if (t.o === null) t.o = s.cur;
    src.u -= nU; t.u += nU;
    src.a -= nA; t.a += nA;
    s.moves -= (nU + nA);
    log.push(`${s.players[s.cur].name} moved ${nU} unit${nU > 1 ? 's' : ''}${nA ? ` and ${nA} armory` : ''} ${a.x},${a.y} → ${a.tx},${a.ty} (${tier(s, t.u)})`
      + (absorb ? ` absorbing a neutral stack of ${absorb}.` : '')
      + (claim ? ` and picked up ${claim} loose armory.` : ''));
  }

  if (src.u <= 0) {
    strand(s, sk, src, log, src.a > 0 ? `${src.a} armory left behind at ${a.x},${a.y} — anyone can claim it.` : null);
  }

  if (c.autoEndMove && s.moves <= 0 && !canBurnAnywhere(s)) {
    log.push('Last move spent.');
    finishTurn(s, log, rng);
  }
}


/* ---------- rules, shown in-app ---------- */
const rulesText = `
## Stacks

Every square can hold a stack of two kinds of chips: "unit" chips, and "armory"
chips. The number of **units** in a stack determines what type of stack it is;
**armory chips** ride on top of the units as its ammunition, its shield, and a
general store of energy. The following is a list of unit stacks and their
names:

- \`1\` **pawn** — holds ground, produces nothing, and must touch another of
  your stacks at the end of your play or it is abandoned. A pawn stakes out
  territory. The more squares of territory you have, the more turns you can
  take in the move step. Stacked up, two pawns make a knight.
- \`2–3\` **knight** — self-supporting, produces armory. A knight is 2 pawns in
  the same stack, making them self-supporting. In other words, a knight doesn't
  need to touch another stack at the end of play, so they can wander the board
  independently. Generally speaking, every 2 units in a stack produces 1 armory
  during the production step, so a knight naturally produces 1 armory. Stacked
  up, 2 knights make a camp.
- \`4–7\` **camp** — self-supporting, produces pawns or armory. A camp, being
  4 units high, can be said to be either 4 pawns, or 2 knights...or a knight
  and 2 pawns, etc. As such, it produces armory equal to the total number of
  knights in the stack. Additionally, and again generally speaking, 2 armory
  can be melted into a unit chip, so a camp with 4 pawns (or 2 knights) can
  also produce a single unit chip...a pawn. Two camps stacked up make a town.
- \`8+\` **town** — produces knights, pawns, or armory. Following the same
  rules above, a town is essentially 2 camps put together, and can produce the
  same units or armory as two camps can.

## 1 · Production step

Each of your stacks of two or more chips gets production points equal to its
unit chips, spent freely on itself or any neighbour:

- armory chip — \`2\` points (must land on a stack of yours)
- pawn — \`4\` points
- knight — \`8\` points

A knight makes one armory. A camp makes two armory or one pawn. A town makes
four armory, two pawns, one knight, or any mix its chips allow.

## 2 · Move step

You get one move per square you occupy at the start of the step. One move
shifts one chip to one adjacent square, and that counts armory chips too: a
knight carrying one armory is three chips, so walking the whole thing one
square costs three moves.

Armory rides only where units go. Sent on its own it is either passed to
another of your stacks or thrown at an enemy. A group carrying armory can't
attack — attackers die, and you would be handing over your ammunition.

So a knight walking alone costs two moves per square. Lay a road of pawns and a
single chip can run its length, one move per square, turning the far pawn into
a knight when it arrives.

## Battle

Move chips onto an enemy stack and the attackers die. Each attacking chip lands
one hit; you may also spend armory from the attacking stack, one extra hit per
chip. The defender's armory blocks first — one chip absorbed per hit — and only
then do units fall.

You can also **throw armory**: send an armory chip onto an enemy stack for one
move. The chip is spent and deals two hits, taking their armory first, then
their units.

## Loose armory and neutral stacks

Armory can't sit on bare ground under its own power, but it doesn't vanish
either. When a stack loses its last unit chip — walked away, or killed — its
armory stays on the square as **loose armory**, owned by nobody and unable to
move. Any player who walks a unit chip onto that square picks the whole pile up.

The board is scattered with **neutral stacks** before anyone pitches a camp, so
you can see what is out there and choose your ground with it in mind. A neutral
stack doesn't move, produce, or fight. Finish a play with one of your stacks
beside it and it joins you — so it's a race, and whoever arrives last gets
nothing. You can also simply march onto one and absorb it. Camps must stand
clear of one another, but nothing stops you pitching one right beside a neutral
stack — and the good ground tends to be spoken for early.

## Where a lone chip may step

A single unit chip can only step onto ground that something of yours already
holds. Chips walk a road you have already built; they don't wander into open
country and hope. This is the same support rule that kills abandoned pawns,
applied one move earlier so you can't strand a chip by accident.

## Abandoned pawns

A pawn must touch another of your stacks at the end of your play. If it doesn't,
look at who *is* standing beside it: a rival holding that ground takes the pawn
in, chips and armory and all. A pawn with nobody beside it turns neutral — it
stops being yours, sits where it is, and the next player to support it takes it.

This cuts both ways, and it doesn't wait for the owner's turn. If you sever an
enemy pawn from its support and end your play next to it, it comes over to you.
Where two rivals both stand beside a stranded pawn, the one with more unit chips
against it takes it.

## Trading armory for time

Armory, moves, and chips are one substance in three shapes. During the move step
you can **burn** an armory chip off a stack for a move, spend a move to **forge**
a chip back onto one, or beat **two armory into a unit chip** on the stack that
holds them.

That last trade is a camp's own arithmetic run backwards: two knights make two
armory, and a camp makes a pawn, so two armory and a pawn are the same thing said
twice.

Whatever moves you still hold when the play ends don't vanish — they spill onto
the ground near your own squares as loose armory, one chip per two moves, free
for anyone to pick up. Sitting on unused time leaves it lying around where your
rivals can find it.

## Guard rails

Your last camp is protected: moves that would drop it below camp size are
refused. The production step ends on its own once no stack can afford anything,
and any points you end the step without spending are banked into the stack that
earned them — knights first, then pawns, then armory.

## Winning

Finish a play without a camp and you are out, pieces and all. Last ruler with a
camp wins. If the last camps fall together, it is a draw. In a solo sandbox there
is nobody to beat, so the game runs until you choose to stop.
`;

/* ============================================================
   THE RULESET
   ============================================================ */
const territory = {
  id: 'territory',
  name: 'Territory',
  version: '2.0',
  config,
  configSpec,
  rulesText,

  createInitialState(config, rng, players = []) {
    const s = {
      config: structuredClone(config),
      phase: 'place',
      board: {},
      budget: {},
      players: players.map(p => ({ alive: true, ...p })),
      starts: [],
      cur: 0,
      placeIdx: 0,
      moves: 0,
      territory: 0,
      turnNo: 1,
      winner: null,
      openingNote: null,
    };
    // The ground is laid before anyone chooses where to stand.
    scatterNeutrals(s, rng);
    return s;
  },

  legalActions(state, actorId, scope = null) {
    const s = state;
    const out = [];
    if (s.phase === 'over') return out;
    if (actorId !== s.cur && !(s.phase === 'place' && actorId === s.placeIdx)) return out;

    if (s.phase === 'place') {
      // The infinite board makes "every legal square" meaningless, so
      // offer a workable window around the existing starts instead. The
      // UI lets a player click anywhere and checks with isLegal().
      // Wide enough to take in the scattered ground, so a player can
      // see the resources they are choosing between.
      const R = Math.max(cfg(s).campSpacing * 2, cfg(s).scatterRadius, 6);
      const origins = s.starts.length ? s.starts : [[0, 0]];
      const seen = new Set();
      for (const [ox, oy] of origins) {
        for (let dx = -R; dx <= R; dx++) {
          for (let dy = -R; dy <= R; dy++) {
            const x = ox + dx, y = oy + dy, k = K(x, y);
            if (seen.has(k)) continue;
            seen.add(k);
            if (canPlace(s, x, y)) out.push({ type: 'place', x, y });
          }
        }
      }
      return out;
    }

    const from = scope && scope.from ? [K(scope.from.x, scope.from.y)] : null;

    if (s.phase === 'production') {
      for (const [k, bud] of Object.entries(s.budget)) {
        if (bud <= 0) continue;
        if (from && !from.includes(k)) continue;
        const [x, y] = un(k);
        for (const product of ['armory', 'pawn', 'knight']) {
          for (const [tx, ty] of prodTargets(s, x, y, product)) {
            out.push({ type: 'produce', x, y, tx, ty, product });
          }
        }
      }
      out.push({ type: 'endProduction' });
      return out;
    }

    if (s.phase === 'move') {
      const c = cfg(s);
      for (const [k, st] of Object.entries(s.board)) {
        if (st.o !== s.cur) continue;
        if (from && !from.includes(k)) continue;
        const [x, y] = un(k);

        // Chip splits: any number of units, any number of armory, within
        // the move budget. Bounded by moves, so this stays small.
        for (let nU = 0; nU <= Math.min(st.u, s.moves); nU++) {
          for (let nA = 0; nA <= Math.min(st.a, s.moves - nU); nA++) {
            if (nU + nA < 1) continue;
            for (const [tx, ty] of moveTargets(s, x, y, nU, nA)) {
              const t = at(s, tx, ty);
              if (foeAt(s, t, s.cur) && nU > 0) {
                // An attack may also burn armory off the attacking stack.
                for (let spend = 0; spend <= st.a; spend++) {
                  out.push({ type: 'move', x, y, tx, ty, nU, nA, spend });
                }
              } else {
                out.push({ type: 'move', x, y, tx, ty, nU, nA, spend: 0 });
              }
            }
          }
        }

        if (c.burnArmory > 0 && st.a >= 1) out.push({ type: 'burn', x, y });
        if (c.forgeCost > 0 && st.u >= 1 && s.moves >= c.forgeCost) out.push({ type: 'forge', x, y });
        if (c.meltCost >= 1 && st.a >= c.meltCost) out.push({ type: 'melt', x, y });
      }
      out.push({ type: 'endTurn' });
      return out;
    }
    return out;
  },

  isLegal(state, action, actorId) {
    const s = state;
    if (s.phase === 'over') return false;
    const a = action;

    if (s.phase === 'place') {
      return a.type === 'place' && actorId === s.placeIdx && canPlace(s, a.x, a.y);
    }
    if (actorId !== s.cur) return false;

    if (s.phase === 'production') {
      if (a.type === 'endProduction') return true;
      if (a.type !== 'produce') return false;
      if (!['armory', 'pawn', 'knight'].includes(a.product)) return false;
      return prodTargets(s, a.x, a.y, a.product).some(([tx, ty]) => tx === a.tx && ty === a.ty);
    }

    if (s.phase === 'move') {
      const c = cfg(s);
      const st = at(s, a.x, a.y);
      if (a.type === 'endTurn') return true;
      if (a.type === 'burn') return !!st && st.o === s.cur && st.a >= 1 && c.burnArmory > 0;
      if (a.type === 'forge') return !!st && st.o === s.cur && st.u >= 1 && c.forgeCost > 0 && s.moves >= c.forgeCost;
      if (a.type === 'melt') return !!st && st.o === s.cur && c.meltCost >= 1 && st.a >= c.meltCost;
      if (a.type !== 'move') return false;
      if (!Number.isInteger(a.nU) || !Number.isInteger(a.nA) || a.nU < 0 || a.nA < 0) return false;
      const spend = a.spend || 0;
      if (spend < 0 || !st || spend > st.a) return false;
      const t = at(s, a.tx, a.ty);
      if (spend > 0 && !(foeAt(s, t, s.cur) && a.nU > 0)) return false;
      return moveTargets(s, a.x, a.y, a.nU, a.nA).some(([tx, ty]) => tx === a.tx && ty === a.ty);
    }
    return false;
  },

  applyAction(state, action, rng) {
    const s = state, a = action, log = [];
    const c = cfg(s);

    // The opening scatter happens before any action, so its note waits
    // here for the first one to carry it into the record. It is added
    // AFTER the action's own line rather than before: the first line an
    // action writes is the one the record lets you rewind to, and that
    // should be the move itself, not the scene-setting.
    const note = s.openingNote;
    s.openingNote = null;

    switch (a.type) {
      case 'place': {
        s.board[K(a.x, a.y)] = { o: s.placeIdx, u: c.startCamp, a: 0 };
        s.starts.push([a.x, a.y]);
        log.push(`${s.players[s.placeIdx].name} pitched camp at ${a.x},${a.y}.`);
        s.placeIdx++;
        if (s.placeIdx < s.players.length) {
          s.cur = s.placeIdx;
        } else {
          s.cur = 0;
          startProduction(s, log);
        }
        break;
      }
      case 'produce':
        doProduce(s, a, log);
        break;
      case 'endProduction':
        finishProduction(s, log);
        break;
      case 'move':
        doMove(s, a, rng, log);
        break;
      case 'burn': {
        const st = at(s, a.x, a.y);
        st.a--; s.moves += c.burnArmory;
        log.push(`${s.players[s.cur].name} burned an armory chip at ${a.x},${a.y} for ${c.burnArmory} move${c.burnArmory === 1 ? '' : 's'}.`);
        break;
      }
      case 'forge': {
        const st = at(s, a.x, a.y);
        s.moves -= c.forgeCost; st.a++;
        log.push(`${s.players[s.cur].name} forged an armory chip at ${a.x},${a.y} for ${c.forgeCost} move${c.forgeCost === 1 ? '' : 's'}.`);
        break;
      }
      case 'melt': {
        const st = at(s, a.x, a.y);
        st.a -= c.meltCost; st.u += 1;
        log.push(`${s.players[s.cur].name} beat ${c.meltCost} armory into a unit chip at ${a.x},${a.y} (${tier(s, st.u)}).`);
        break;
      }
      case 'endTurn':
        finishTurn(s, log, rng);
        break;
      default:
        throw new Error('Unknown action type: ' + a.type);
    }
    if (note) log.push(note);
    return log;
  },

  describeAction(state, a) {
    const from = { x: a.x, y: a.y };
    switch (a.type) {
      case 'place':
        return { from: null, to: from, label: 'Pitch camp' };
      case 'produce':
        return {
          from, to: { x: a.tx, y: a.ty },
          label: `Produce ${a.product}`,
          group: a.product,
        };
      case 'move': {
        const t = at(state, a.tx, a.ty);
        const hostile = foeAt(state, t, state.cur);
        const chips = `${a.nU}u${a.nA ? '+' + a.nA + 'a' : ''}`;
        return {
          from, to: { x: a.tx, y: a.ty },
          label: hostile
            ? `Strike with ${chips}${a.spend ? ` (+${a.spend} armory)` : ''}`
            : `Move ${chips}`,
          group: hostile ? 'attack' : 'move',
        };
      }
      case 'burn': return { from, to: from, label: 'Burn armory for a move', group: 'trade' };
      case 'forge': return { from, to: from, label: 'Forge armory', group: 'trade' };
      case 'melt': return { from, to: from, label: 'Melt armory into a chip', group: 'trade' };
      case 'endProduction': return { from: null, to: null, label: 'Done producing', group: 'phase' };
      case 'endTurn': return { from: null, to: null, label: 'End play', group: 'phase' };
      default: return { from: null, to: null, label: a.type };
    }
  },

  isTerminal(state) {
    if (state.phase !== 'over') return null;
    return {
      winnerId: state.winner,
      reason: state.winner === null ? 'Every camp fell in the same breath.' : 'Last ruler holding a camp.',
    };
  },

  /**
   * Territory's own worth-of-a-position, overriding the generic one.
   *
   * The generic evaluator counts every counter alike, which here means
   * an armory chip weighs the same as a unit chip. That is wrong in a
   * specific and exploitable way: forging turns moves — which the
   * generic scorer doesn't value at all — into armory, which it does.
   * An AI on the generic scorer spends its entire turn forging and
   * never moves. This is the escape hatch the contract offers for
   * exactly that: a game whose resources aren't interchangeable has to
   * say so itself.
   */
  /**
   * What a Territory position is worth.
   *
   * The insight this is built on, from playtesting: **position matters
   * less than production.** Counting chips and squares — which is what
   * the generic evaluator and the first version of this one did — misses
   * the whole game, because Territory's resources are convertible into
   * one another and what actually matters is the rate they come in at.
   *
   * So everything here is converted to one unit: MOVES PER TURN.
   *
   *   a held square      -> moveFactor moves a turn
   *   a stack of 2+      -> floor(u * prodFactor) production points,
   *                         which buy floor(points / costArmory) armory,
   *                         each burnable for burnArmory moves
   *
   * Run those numbers on the defaults and a knight yields one move for
   * the square it stands on plus one for the armory it makes: exactly
   * what two pawns spread over two squares yield. That equivalence is
   * real, it is what makes the pawn-versus-knight choice a genuine
   * trade rather than a right answer, and an evaluator that doesn't
   * reproduce it is not looking at the same game the player is.
   *
   * The differences that remain are the interesting ones, and each has a
   * term below:
   *
   *   - A pawn must be supported or it is abandoned; a knight supports
   *     itself and can wander. Sprawling into pawns buys income at the
   *     cost of fragility.
   *   - Armory in hand is banked moves. It is what pays for reach: bank
   *     enough and a knight can cross empty ground to strike a distant
   *     camp, which is a real strategy and needs a stock to fund.
   *   - A strike is only worth its losses if it cuts the opponent's
   *     production. Since the score is ours minus theirs and both are
   *     measured as income, damage to a producing stack shows up as
   *     exactly the gain it is — and trading chips for a pawn does not.
   *   - Losing your last camp ends your game, so it outweighs economics.
   */
  evaluate(state, actorId) {
    const c = cfg(state);
    const me = state.players[actorId];
    if (me && me.alive === false) return -1000000;

    // All in moves-per-turn unless noted. Tunable: these are the numbers
    // to argue with if the bot plays in a way that looks wrong.
    const W = {
      income: 10,      // the engine of the game
      armory: 3,       // banked moves, and the fuel for a distant strike
      unit: 1.5,       // chips as capital: they can be stacked into income
      camp: 22,        // insurance against losing the one you have
      campCap: 2,      // ...but only up to a point; see below
      town: 5,         // a bigger producer
      survival: 80,    // holding any camp at all
      stranded: 14,    // a pawn about to be abandoned is nearly lost already
      reach: 0.4,      // stored moves are what let you strike far away
    };

    const count = state.players.map(() => ({
      squares: 0, units: 0, armory: 0, armoryIncome: 0,
      camps: 0, towns: 0, stranded: 0,
    }));

    for (const [k, st] of Object.entries(state.board)) {
      if (st.o === null) continue;
      const t = count[st.o];
      if (!t) continue;

      t.squares++;
      t.units += st.u;
      t.armory += st.a;

      // Only a stack of two or more produces anything at all.
      if (st.u >= c.knightSize) {
        const points = Math.floor(st.u * c.prodFactor);
        t.armoryIncome += Math.floor(points / Math.max(1, c.costArmory));
      }
      if (st.u >= c.campSize) t.camps++;
      if (st.u >= c.townSize) t.towns++;

      // A lone pawn with nothing of its owner's beside it will be
      // abandoned at the end of their play — it is income on paper only.
      if (st.u === 1 && c.pawnSupport) {
        const [x, y] = un(k);
        const held = nbs(state, x, y).some(([i, j]) => {
          const q = at(state, i, j);
          return q && q.o === st.o && q.u >= 1;
        });
        if (!held) t.stranded++;
      }
    }

    const worth = (id) => {
      const t = count[id];
      if (!t) return 0;

      // Moves a turn: ground plus what production can be burned for.
      const income = t.squares * c.moveFactor + t.armoryIncome * c.burnArmory;

      // Camps are insurance, not a currency. The first is survival. A
      // second means a strike on one doesn't end your game — which is
      // worth a great deal, because a single camp is a single point of
      // failure and the bot will happily be talked into one. Past two
      // they are just large stacks, and their production is already
      // counted in income, so the bonus is capped rather than linear.
      //
      // Measured over four games: uncapped at weight 16 the bot built
      // five to seven camps and generated 132 moves a turn; capped at
      // two with weight 22 it holds two camps and generates 156. Paying
      // for redundancy is cheap; hoarding it is not.
      const insured = Math.min(t.camps, W.campCap);

      return W.income * income
        + W.armory * t.armory
        + W.reach * t.armory * c.burnArmory
        + W.unit * t.units
        + W.camp * insured
        + W.town * t.towns
        + (t.camps > 0 ? W.survival : 0)
        - W.stranded * t.stranded;
    };

    let score = worth(actorId);
    for (let i = 0; i < state.players.length; i++) {
      if (i === actorId) continue;
      if (state.players[i].alive === false) continue;
      score -= worth(i);
    }

    // Moves still in hand this turn are spendable now, so they are worth
    // slightly more than the same number arriving next turn — but not so
    // much that hoarding them looks better than using them.
    if (state.cur === actorId) score += 0.6 * (state.moves || 0);

    return score;
  },

  /** Every square holding something — see occupiedCells in the contract. */
  occupiedCells(state) {
    const out = [];
    for (const k of Object.keys(state.board)) {
      const [x, y] = k.split(',').map(Number);
      out.push({ x, y });
    }
    return out;
  },

  describeCell(state, x, y) {
    const st = at(state, x, y);
    if (!st) return null;
    const neutral = st.o === null;
    const loose = neutral && st.u === 0;
    const p = neutral ? null : state.players[st.o];
    return {
      ownerId: st.o,
      label: loose ? 'LOOSE' : tier(state, st.u).toUpperCase(),
      classes: ['stack', neutral ? 'neutral' : 'owned', loose ? 'loose' : ''].filter(Boolean),
      counters: [
        { kind: 'units', value: st.u },
        { kind: 'armory', value: st.a },
      ],
      colors: p ? {
        'unit-color': p.colors?.primary || '#7E938C',
        'armory-color': p.colors?.accent || '#C8A24A',
      } : {},
      stackHeight: Math.min(st.u + st.a, 8),
    };
  },

  describeActor(state, id) {
    const p = state.players[id];
    if (!p) return null;
    return {
      name: p.name,
      colors: p.colors || {},
      status: `${occupied(state, id)} sq · ${hasCamp(state, id) ? 'camp' : 'NO CAMP'}`,
      alive: p.alive,
    };
  },

  summarize(state) {
    return {
      phase: state.phase,
      turnNo: state.turnNo,
      current: state.cur,
      moves: state.moves,
      territory: state.territory,
    };
  },

  // Helpers the UI and AI may lean on. Not part of the required contract,
  // but exported so neither has to reimplement the rules to ask a question.
  helpers: { K, un, at, tier, nbs, occupied, hasCamp, campCount, moveTargets, prodTargets, isCache, foeAt },
};

export default territory;
