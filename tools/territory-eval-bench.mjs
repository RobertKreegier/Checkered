/* Run from the repo root:  node tools/territory-eval-bench.mjs [games] [turns]
 *
 * Compares two Territory evaluators by playing them against each other
 * and scoring the result in moves-per-turn generated — a yardstick
 * neither of them optimises directly.
 */

import { Engine } from '../root/src/engine.js';
import { greedyAi, playTurn, seededRandom } from '../root/src/ai-api.js';
import { getRuleset } from '../root/rulesets/index.js';

const entry = getRuleset('territory');
const rs = entry.ruleset;

function oldEval(state, actorId) {
  const c = state.config;
  const me = state.players[actorId];
  if (me && me.alive === false) return -1000000;
  let score = 0;
  for (const st of Object.values(state.board)) {
    if (st.o === null) continue;
    const sign = st.o === actorId ? 1 : -1;
    score += sign * 6 + sign * 4 * st.u + sign * 1.5 * st.a;
    if (st.u >= c.campSize) score += sign * 25;
    if (st.u >= c.townSize) score += sign * 15;
  }
  if (state.cur === actorId) score += 0.5 * (state.moves || 0);
  return score;
}

function withEval(name, evaluate) {
  const inner = greedyAi();
  return { id: name, name, version: '1',
    chooseAction: ctx => inner.chooseAction({
      ...ctx, ruleset: { ...ctx.ruleset, evaluate },
      evaluate: (s, who = ctx.actorId) => evaluate(s, who),
    }) };
}

/** A neutral yardstick: squares held, and armory produced per turn. */
function report(state, id) {
  const c = state.config;
  let squares = 0, units = 0, armory = 0, income = 0, camps = 0;
  for (const st of Object.values(state.board)) {
    if (st.o !== id) continue;
    squares++; units += st.u; armory += st.a;
    if (st.u >= c.knightSize) income += Math.floor(Math.floor(st.u * c.prodFactor) / c.costArmory);
    if (st.u >= c.campSize) camps++;
  }
  return { squares, units, armory, income, camps, moves: squares + income };
}

const newAi = withEval('income', rs.evaluate.bind(rs));
const oldAi = withEval('chips', oldEval);
const games = Number(process.argv[2] || 4);
const turns = Number(process.argv[3] || 16);
let ahead = 0, behind = 0, level = 0;
const totals = { neu: 0, old: 0 };

for (let g = 0; g < games; g++) {
  const eng = new Engine(rs, { players: entry.defaultPlayers.slice(0, 2), seed: g + 1,
    config: { scatterStacks: 2 } });
  eng.applyAction({ type: 'place', x: 0, y: 0 }, 0);
  eng.applyAction({ type: 'place', x: 7, y: 1 }, 1);
  const rng = seededRandom(g * 31 + 5);
  const seat = g % 2;                       // alternate who moves first
  let n = 0;
  while (!eng.isOver() && n++ < turns) {
    playTurn(eng, eng.state.cur === seat ? newAi : oldAi, eng.state.cur, rng);
  }
  const a = report(eng.state, seat), b = report(eng.state, 1 - seat);
  totals.neu += a.moves; totals.old += b.moves;
  if (a.moves > b.moves) ahead++; else if (a.moves < b.moves) behind++; else level++;
  console.log(`game ${g + 1}: income-eval ${JSON.stringify(a)}  vs  chip-eval ${JSON.stringify(b)}`);
}
console.log(`\nmoves-per-turn generated — income eval ahead in ${ahead}, behind ${behind}, level ${level}`);
console.log(`totals: income eval ${totals.neu}, chip eval ${totals.old}`);
