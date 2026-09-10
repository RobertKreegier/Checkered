/* ai-search.js — an AI that looks further than one move.
 *
 * The greedy player in ai-api.js takes the best immediate move and
 * checks what can be taken straight back. That is a hard ceiling: it
 * walks into anything that takes two moves to punish, because it never
 * looks that far.
 *
 * This one searches. Standard game-tree machinery, nothing exotic:
 *
 *   minimax          assume the opponent picks their best reply too
 *   alpha-beta       stop searching branches that cannot change the answer
 *   iterative deepening   search depth 1, then 2, then 3, until time runs
 *                    out, so there is always a usable answer in hand
 *   move ordering    try promising moves first, which is what makes
 *                    alpha-beta actually prune
 *   transposition table   remember positions already scored
 *   quiescence       don't stop counting in the middle of an exchange
 *
 * It uses only the ruleset contract, so it works for any registered
 * game without knowing which one it is.
 *
 * WHERE IT DOES NOT HELP. Minimax assumes turns are single moves that
 * alternate. Territory's turn is a *sequence* — around a hundred
 * actions, fifty-odd options at each — so a single ply of "one player's
 * whole turn" is already an astronomically wide tree. The budget below
 * keeps it honest rather than pretending: given a game it cannot search,
 * it returns the best move it managed to look at, which degrades to
 * roughly greedy play rather than to a frozen page.
 */

import { Rng } from './rng.js';
import {
  evaluateState, positionHash, DEFAULT_WEIGHTS, registerAi, greedyAi,
} from './ai-api.js';

/** A position is worth this much when it is won. Beats any evaluation. */
const WIN = 1e6;

/**
 * Is this a game a tree search can actually help with?
 *
 * Minimax assumes a turn is one move and then the opponent replies. Some
 * games aren't shaped like that: a Territory turn is a sequence of a
 * hundred-odd actions, so "search one ply" already means enumerating an
 * entire turn, and the tree is astronomically wide before it is one move
 * deep. Measured: searching Territory cost 3 seconds a turn and played
 * no better than greedy.
 *
 * Rather than pretend, sample a few actions and see whether taking one
 * hands the turn over. If it usually doesn't, this is a sequence game
 * and the search delegates to the greedy player, which is both faster
 * and — here — no worse.
 */
function searchable(ruleset, state, actions, actorId) {
  if (actions.length > 120) return false;         // too wide to be worth it

  const sample = actions.slice(0, 6);
  let passesTurn = 0;
  for (const action of sample) {
    const next = step(ruleset, state, action);
    if (next === null) continue;
    if (ruleset.isTerminal(next) || next.cur !== actorId) passesTurn++;
  }
  return passesTurn > sample.length / 2;
}

export const SEARCH_DEFAULTS = {
  maxDepth: 6,          // ply ceiling; iterative deepening rarely reaches it
  maxMillis: 900,       // thinking time per move — a browser has to stay usable
  maxNodes: 120000,     // hard stop, for games whose branching explodes
  quiescence: 4,        // extra plies spent settling an exchange
  quietThreshold: 8,    // a swing bigger than this counts as "not quiet"
};

/**
 * Apply an action to a copy of a state. The search needs this constantly
 * and cannot use Engine.preview(), because it is exploring hypothetical
 * positions that no engine holds.
 */
function step(ruleset, state, action) {
  const draft = structuredClone(state);
  const rng = new Rng(draft.rngState ?? 1);
  try {
    ruleset.applyAction(draft, action, rng);
  } catch {
    return null;
  }
  draft.rngState = rng.state;
  return draft;
}

/**
 * The search.
 *
 * Scores are always from `me`'s point of view: positive is good for the
 * player we are choosing a move for, whoever happens to be on turn in
 * the position being examined. That is what lets one function serve both
 * the maximising and minimising side.
 */
function search(ctx, state, depth, alpha, beta, ply) {
  ctx.nodes++;

  const done = ctx.ruleset.isTerminal(state);
  if (done) {
    // Prefer a win sooner and a loss later: without the ply term, a mate
    // in one and a mate in five look identical and the bot dawdles.
    if (done.winnerId === ctx.me) return WIN - ply;
    if (done.winnerId === null || done.winnerId === undefined) return 0;
    return -WIN + ply;
  }

  if (depth <= 0) return quiesce(ctx, state, alpha, beta, ctx.opts.quiescence, ply);
  if (ctx.stop()) return score(ctx, state);

  const key = positionHash(state) + ':' + depth;
  const hit = ctx.table.get(key);
  if (hit !== undefined) return hit;

  const mover = state.cur;
  const maximising = mover === ctx.me;
  const actions = ordered(ctx, state, mover);

  // No legal move is not automatically a loss — some games pass, some
  // end. If isTerminal() didn't say the game was over, take the position
  // at face value rather than inventing a result.
  if (!actions.length) return score(ctx, state);

  let best = maximising ? -Infinity : Infinity;

  for (const { action } of actions) {
    const next = step(ctx.ruleset, state, action);
    if (next === null) continue;

    const value = search(ctx, next, depth - 1, alpha, beta, ply + 1);

    if (maximising) {
      if (value > best) best = value;
      if (best > alpha) alpha = best;
    } else {
      if (value < best) best = value;
      if (best < beta) beta = best;
    }

    // The cutoff. If this branch is already worse for the side to move
    // than something they can get elsewhere, they will never allow it,
    // so the rest of it cannot matter.
    if (alpha >= beta) break;
    if (ctx.stop()) break;
  }

  if (best === Infinity || best === -Infinity) return score(ctx, state);
  ctx.table.set(key, best);
  return best;
}

/**
 * Quiescence: keep looking while the position is still churning.
 *
 * Stopping the search mid-exchange is the classic way to be badly wrong
 * — the bot sees itself capture a piece and stops counting before the
 * recapture, so a losing trade looks like a free one. Rather than
 * defining "capture" (which would mean knowing the game), a move counts
 * as noisy when it swings the evaluation by more than a threshold.
 */
function quiesce(ctx, state, alpha, beta, depth, ply) {
  ctx.nodes++;

  const done = ctx.ruleset.isTerminal(state);
  if (done) {
    if (done.winnerId === ctx.me) return WIN - ply;
    if (done.winnerId === null || done.winnerId === undefined) return 0;
    return -WIN + ply;
  }

  const standPat = score(ctx, state);
  if (depth <= 0 || ctx.stop()) return standPat;

  const mover = state.cur;
  const maximising = mover === ctx.me;

  // "Stand pat": the side to move can usually decline to stir things up,
  // so the quiet score is a floor for them, not something they must beat.
  if (maximising) {
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
  } else {
    if (standPat <= alpha) return standPat;
    if (standPat < beta) beta = standPat;
  }

  let best = standPat;

  for (const { action, delta } of ordered(ctx, state, mover)) {
    if (Math.abs(delta) < ctx.opts.quietThreshold) continue;   // quiet; leave it
    const next = step(ctx.ruleset, state, action);
    if (next === null) continue;

    const value = quiesce(ctx, next, alpha, beta, depth - 1, ply + 1);

    if (maximising) {
      if (value > best) best = value;
      if (best > alpha) alpha = best;
    } else {
      if (value < best) best = value;
      if (best < beta) beta = best;
    }
    if (alpha >= beta) break;
    if (ctx.stop()) break;
  }

  return best;
}

/** Score a position from `me`'s point of view. */
function score(ctx, state) {
  return evaluateState(ctx.ruleset, state, ctx.me, ctx.weights);
}

/**
 * Legal moves, best-looking first.
 *
 * Alpha-beta only prunes well when good moves are tried early — with
 * bad ordering it degenerates towards plain minimax and searches
 * everything. Sorting by the immediate evaluation swing is cheap and
 * approximates "captures first" without knowing what a capture is.
 *
 * The list is capped, because Territory can offer enough actions that
 * even ordering them is expensive.
 */
function ordered(ctx, state, mover) {
  let actions;
  try {
    actions = ctx.ruleset.legalActions(state, mover, null) || [];
  } catch {
    return [];
  }

  const before = evaluateState(ctx.ruleset, state, ctx.me, ctx.positional);
  const scored = [];

  for (const action of actions) {
    if (scored.length >= ctx.opts.maxBranch) break;
    const next = step(ctx.ruleset, state, action);
    if (next === null) continue;
    const delta = evaluateState(ctx.ruleset, next, ctx.me, ctx.positional) - before;
    scored.push({ action, delta });
  }

  // The mover wants the swing to go their way, so sort accordingly.
  scored.sort((a, b) => (mover === ctx.me ? b.delta - a.delta : a.delta - b.delta));
  return scored;
}

/**
 * Build the searching AI.
 *
 * `maxMillis` is the honest knob: everything else adjusts itself around
 * it through iterative deepening.
 */
export function searchAi(overrides = {}) {
  const opts = { ...SEARCH_DEFAULTS, ...overrides };
  const weights = { ...DEFAULT_WEIGHTS, ...overrides };

  return {
    id: 'search',
    name: 'Thinker',
    version: '1.0.0',
    weights: { ...weights, ...opts },
    weightSpec: [
      ['maxMillis', 'Thinking time per move, in milliseconds'],
      ['maxDepth', 'How many moves ahead to look, at most'],
      ['quiescence', 'Extra depth spent settling an exchange'],
      ['material', 'Value of pieces and chips'],
      ['ground', 'Value of squares held'],
    ],
    description: 'Searches ahead with alpha-beta pruning, deepening until its '
      + 'time is up. Much stronger than Greedy at games where a turn is a '
      + 'single move; in Territory, where one turn is a hundred actions, the '
      + 'tree is too wide to search and it falls back to shallow play.',

    chooseAction(ctxIn) {
      const { actions, ruleset, actorId, rng, state } = ctxIn;
      if (!actions.length) return null;

      // A game whose turn is a sequence rather than a single move gets
      // the greedy player instead. Searching it is slower and no
      // stronger, and pretending otherwise would just make the bot
      // unusable in Territory.
      if (!searchable(ruleset, state, actions, actorId)) {
        return greedyAi(weights).chooseAction(ctxIn);
      }

      const deadline = Date.now() + (opts.maxMillis ?? SEARCH_DEFAULTS.maxMillis);
      const ctx = {
        ruleset,
        me: actorId,
        weights,
        // Ordering and quiescence use a cheaper score with no mobility
        // term: mobility calls legalActions again, which is the single
        // most expensive thing available and swamps the search.
        positional: { ...weights, mobility: 0 },
        opts: {
          ...opts,
          maxBranch: opts.maxBranch ?? 40,
        },
        table: new Map(),
        nodes: 0,
        stop: () => Date.now() > deadline || ctx.nodes > opts.maxNodes,
      };

      const seen = ctxIn.seen || new Set();
      const root = ordered(ctx, state, actorId)
        .filter(({ action }) => {
          // Never walk back into a position already occupied this turn;
          // Territory's forge and burn undo each other exactly.
          const next = step(ruleset, state, action);
          return next === null || !seen.has(positionHash(next));
        });
      if (!root.length) return actions[0];

      let best = root[0].action;

      // Iterative deepening. Each pass is a complete search, so whenever
      // time runs out there is always a finished answer to fall back on
      // — and the shallow pass usefully orders the deeper one.
      for (let depth = 1; depth <= opts.maxDepth; depth++) {
        let localBest = null;
        let localScore = -Infinity;
        let alpha = -Infinity;

        for (const { action } of root) {
          const next = step(ruleset, state, action);
          if (next === null) continue;

          // A turn may not have changed hands — Territory produces, then
          // moves, then ends its turn — so this is not simply "now the
          // opponent replies". search() works out whose turn it is.
          const value = search(ctx, next, depth - 1, alpha, Infinity, 1);

          if (value > localScore) { localScore = value; localBest = action; }
          if (value > alpha) alpha = value;
          if (ctx.stop()) break;
        }

        // Only trust a pass that finished; a truncated one may have
        // looked at three moves out of forty.
        if (localBest && !ctx.stop()) best = localBest;
        else if (localBest && depth === 1) best = localBest;

        if (ctx.stop()) break;
        if (Math.abs(localScore) >= WIN - 100) break;   // found a forced result
      }

      // Break ties without a fixed preference, so repeat games differ.
      if (weights.jitter && root.length > 1 && rng() < 0.02) {
        return root[Math.floor(rng() * Math.min(3, root.length))].action;
      }
      return best;
    },
  };
}

registerAi(searchAi);

export default searchAi;
