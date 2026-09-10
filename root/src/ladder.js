/* ladder.js — does one bot actually beat another?
 *
 * Built before the stronger AI, deliberately. "Better" is easy to feel
 * and easy to get wrong: the first greedy player lost every game of
 * checkers to random play while looking perfectly reasonable in a
 * single game watched by eye. A number settles it.
 *
 * Every match is seeded, and the seats alternate so neither side keeps
 * the advantage of moving first.
 */

import { Engine } from './engine.js';
import { playTurn, seededRandom } from './ai-api.js';

/** Openings a game needs before real play begins. */
const OPENINGS = {
  territory: [
    { action: { type: 'place', x: 0, y: 0 }, actorId: 0 },
    { action: { type: 'place', x: 7, y: 2 }, actorId: 1 },
  ],
};

/**
 * Play one game and say who won.
 *
 * `challenger` takes seat `seat`; `holder` takes the other. Returns
 * 'win' / 'loss' / 'draw' from the challenger's point of view, plus how
 * long each side spent thinking.
 */
export function playMatch(entry, challenger, holder, { seed = 1, seat = 0, maxTurns = 300 } = {}) {
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, 2),
    config: entry.id === 'territory' ? { scatterStacks: 2 } : {},
    seed,
  });
  for (const { action, actorId } of OPENINGS[entry.id] || []) eng.applyAction(action, actorId);

  const rng = seededRandom(seed * 7919 + 13);
  const spent = [0, 0];
  let turns = 0;

  while (!eng.isOver() && turns++ < maxTurns) {
    const actor = eng.state.cur;
    const ai = actor === seat ? challenger : holder;
    const t0 = Date.now();
    try {
      playTurn(eng, ai, actor, rng);
    } catch (err) {
      // A bot that breaks forfeits rather than aborting the run — the
      // point is to find out, not to stop.
      return { result: actor === seat ? 'loss' : 'win', error: err.message, spent, turns };
    }
    spent[actor === seat ? 0 : 1] += Date.now() - t0;
  }

  const r = eng.result();
  let result;
  if (!r) result = 'unfinished';
  else if (r.winnerId === seat) result = 'win';
  else if (r.winnerId === null) result = 'draw';
  else result = 'loss';

  return { result, spent, turns };
}

/**
 * Play a series and report the record.
 *
 * Seats alternate game by game. `games` should be even so each bot plays
 * each side the same number of times.
 */
export function runLadder(entry, challenger, holder, { games = 20, maxTurns = 300 } = {}) {
  const tally = { win: 0, loss: 0, draw: 0, unfinished: 0 };
  const spent = [0, 0];
  let moves = [0, 0];
  const errors = [];

  for (let g = 0; g < games; g++) {
    const m = playMatch(entry, challenger, holder, {
      seed: g + 1,
      seat: g % 2,
      maxTurns,
    });
    tally[m.result]++;
    spent[0] += m.spent[0];
    spent[1] += m.spent[1];
    moves[0] += m.turns;
    if (m.error) errors.push(m.error);
  }

  const decided = tally.win + tally.loss + tally.draw;
  return {
    game: entry.name,
    ...tally,
    // Draws count half, the usual convention, so 0.5 is an even match.
    score: decided ? (tally.win + tally.draw / 2) / decided : 0,
    msPerTurn: [
      moves[0] ? Math.round(spent[0] / moves[0]) : 0,
      moves[0] ? Math.round(spent[1] / moves[0]) : 0,
    ],
    errors: errors.slice(0, 3),
  };
}

/** A one-line summary, for printing a run at the terminal. */
export function formatResult(r) {
  const pct = (r.score * 100).toFixed(0);
  return `${r.game.padEnd(12)} ${String(r.win).padStart(3)}W ${String(r.loss).padStart(3)}L `
    + `${String(r.draw).padStart(3)}D  score ${pct}%  `
    + `(${r.msPerTurn[0]}ms vs ${r.msPerTurn[1]}ms per turn)`
    + (r.unfinished ? `  [${r.unfinished} unfinished]` : '')
    + (r.errors.length ? `  ERRORS: ${r.errors[0]}` : '');
}
