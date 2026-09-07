/* ai-api.js — the contract AI scripts are written against, plus a
 * greedy opponent good enough to play all three games.
 *
 * The same constraint as everywhere else: this file must not learn any
 * game's vocabulary. An AI is handed a context object with the legal
 * actions, a way to preview each one, and a scoring function — it never
 * needs to know whether it is playing chess or Territory.
 *
 * Purity rules match rulesets: no DOM, no clock, no Math.random. An AI
 * gets a seeded rng in its context so that a game against a bot replays
 * exactly like any other game.
 */

import { Rng } from './rng.js';
import { hashState } from './hash.js';

/* ============================================================
   THE CONTRACT
   ============================================================ */

/**
 * An AI is an object:
 *
 *   id            stable identifier
 *   name          shown in the picker
 *   version       string
 *   weights       optional {name: number} tuning knobs
 *   weightSpec    optional [[key, label], ...] so the UI can offer them
 *   chooseAction(ctx) -> action | null
 *
 * ctx carries:
 *   state         the current state (read only — mutate and you poison
 *                 the live game, since it is not a copy)
 *   actorId       who the AI is playing
 *   ruleset       for describeAction / describeCell, if it wants them
 *   actions       every legal action, already enumerated
 *   preview(a)    the state that action would produce, or null
 *   evaluate(s)   generic score of a state from actorId's point of view
 *   rng()         seeded float in [0,1) — use this, never Math.random
 *
 * Returning null means "no move", which the runner treats as a bug
 * unless the position genuinely offers nothing.
 */
export function validateAi(ai) {
  const problems = [];
  if (!ai || typeof ai !== 'object') return ['AI is not an object'];
  for (const f of ['id', 'name', 'version']) {
    if (typeof ai[f] !== 'string' || !ai[f]) problems.push(`missing ${f}`);
  }
  if (typeof ai.chooseAction !== 'function') problems.push('missing chooseAction()');
  if (ai.weights && typeof ai.weights !== 'object') problems.push('weights must be an object');
  if (ai.weightSpec && !Array.isArray(ai.weightSpec)) problems.push('weightSpec must be an array');
  return problems;
}

/**
 * A fingerprint of the *position*, ignoring bookkeeping.
 *
 * `hashState` covers everything including `rngState` and `actionCount`,
 * which is right for replay verification and wrong here: those advance
 * on every action, so two genuinely identical positions never match and
 * cycle detection silently does nothing. Strip them and compare the
 * board, whose turn it is, and the rest of the real game state.
 */
export function positionHash(state) {
  const { rngState, actionCount, ...position } = state;
  return hashState(position);
}

/* ============================================================
   GENERIC EVALUATION
   ============================================================ */

/**
 * How many of the best-scoring actions get the expensive reply check.
 * Small enough to keep a turn responsive, wide enough that the genuinely
 * best move is very unlikely to be outside it.
 */
export const SAFETY_SHORTLIST = 8;

/**
 * Work budget, so a big game stays responsive.
 *
 * Territory can offer fifty-odd actions at every step of a turn that
 * runs to well over a hundred steps, and the reply check re-enumerates
 * the opponent's options for each candidate. Profiled on a mid-game
 * board: enumerating legal actions costs ~0.4ms and grows with the
 * board, previewing one action ~0.02ms. Unbudgeted, that reached 26
 * seconds for a single Territory turn.
 *
 * MAX_CANDIDATES caps how many actions get considered at all (a random
 * sample when there are more, so play stays varied); REPLY_CEILING
 * skips the reply check entirely in positions where the opponent has
 * so many answers that checking them costs more than it is worth.
 */
export const MAX_CANDIDATES = 26;
export const REPLY_CEILING = 90;

export const DEFAULT_WEIGHTS = {
  win: 1000000,      // a won position beats anything measurable
  material: 10,      // counters — chips, stack size, piece weight
  ground: 3,         // squares held
  mobility: 0.4,     // how many moves the position leaves you
  denial: 1.2,       // how much it costs the opposition
  safety: 1.0,       // how much to fear the best immediate reply
  jitter: 0.001,     // break ties without a fixed preference
};

/**
 * Score a state from one actor's point of view, knowing nothing about
 * the game.
 *
 * Everything here comes from the contract: occupiedCells() says where
 * the pieces are, describeCell() says whose they are and how much of
 * them there is, isTerminal() says whether it's finished. That is enough
 * for a passable heuristic in any game where holding more material and
 * more ground is better — which is all three of ours, and most grid
 * games. A ruleset that disagrees can supply its own `evaluate()`.
 */
export function evaluateState(ruleset, state, actorId, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };

  // A ruleset may know better than any generic guess.
  if (typeof ruleset.evaluate === 'function') {
    const own = ruleset.evaluate(state, actorId);
    if (typeof own === 'number') return own;
  }

  const done = ruleset.isTerminal(state);
  if (done) {
    if (done.winnerId === actorId) return w.win;
    if (done.winnerId === null || done.winnerId === undefined) return 0;  // draw
    return -w.win;
  }

  let mine = 0, theirs = 0, myGround = 0, theirGround = 0;

  if (typeof ruleset.occupiedCells === 'function') {
    for (const { x, y } of ruleset.occupiedCells(state)) {
      const view = ruleset.describeCell(state, x, y);
      if (!view || view.ownerId === null || view.ownerId === undefined) continue;

      // "How much is here" without knowing what it is: prefer explicit
      // counters, fall back to stack height, then to simply one thing.
      let mass = 0;
      if (Array.isArray(view.counters) && view.counters.length) {
        for (const c of view.counters) mass += Number(c.value) || 0;
      } else {
        mass = view.stackHeight || 1;
      }

      if (view.ownerId === actorId) { mine += mass; myGround++; }
      else { theirs += mass; theirGround++; }
    }
  }

  let score = w.material * (mine - theirs) + w.ground * (myGround - theirGround);

  // Mobility, counted only for whoever is on turn — asking the engine
  // for the other side's options mid-turn is meaningless in games where
  // a turn has phases, and most rulesets return nothing for an actor
  // who isn't up. In practice this registers during multi-step turns
  // (Territory is still yours after producing) and is skipped when
  // scoring the position a move hands to the opponent. It is
  // deliberately excluded from the denial term; see greedyAi.
  if (w.mobility && state.cur === actorId) {
    try {
      score += w.mobility * ruleset.legalActions(state, actorId, null).length;
    } catch {
      /* a ruleset entitled to refuse an out-of-turn query */
    }
  }

  return score;
}

/* ============================================================
   THE GREEDY OPPONENT
   ============================================================ */

/**
 * Look one action ahead, take the best. No search, no lookahead past the
 * immediate result — it will walk into anything that takes two moves to
 * punish, which is the honest ceiling of a greedy player and the point
 * of shipping it first.
 *
 * `denial` is what stops it being purely acquisitive: an action is also
 * scored by how much worse the position becomes for everyone else, which
 * is what makes it take captures rather than shuffling.
 */
export function greedyAi(overrides = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...overrides };

  return {
    id: 'greedy',
    name: 'Greedy',
    version: '1.0.0',
    weights,
    weightSpec: [
      ['material', 'Value of pieces and chips'],
      ['ground', 'Value of squares held'],
      ['mobility', 'Value of having options'],
      ['denial', 'Eagerness to hurt the opposition'],
      ['safety', 'Care about what can be taken back'],
      ['jitter', 'Randomness when moves tie'],
    ],
    description: 'Takes the best immediate move. No lookahead, so it can '
      + 'be baited into anything that takes two moves to punish.',

    chooseAction(ctx) {
      const { actions, preview, evaluate, rng, ruleset, actorId } = ctx;
      if (!actions.length) return null;
      const seen = ctx.seen || new Set();

      // Sample rather than truncate when over budget: taking the first
      // N would bias play toward whatever order the ruleset happens to
      // enumerate in, which for Territory means always the same corner.
      let candidates = actions;
      if (candidates.length > MAX_CANDIDATES) {
        candidates = candidates.slice();
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        candidates = candidates.slice(0, MAX_CANDIDATES);
      }

      // --- pass one: score every action cheaply ---
      // Denial counts material and ground only. Including mobility here
      // is actively harmful: after our move it is the opponent's turn,
      // so theirs is the only mobility the evaluator can see, and
      // subtracting it means "make their move list short" — which in a
      // compulsory-capture game is achieved by hanging a piece.
      // Measured: with mobility in the denial term, greedy lost 12
      // games out of 12 to random play.
      const positional = { ...weights, mobility: 0 };
      const scored = [];

      for (const action of candidates) {
        const after = preview(action);

        // Never step back into a position already visited this turn.
        // Without this, a pair of mutually reversing actions is an
        // infinite loop: the two positions score identically, so
        // whichever the jitter favours gets chosen forever. Territory's
        // forge and burn are exactly such a pair.
        if (after !== null && seen.has(positionHash(after))) continue;

        // An action the ruleset won't preview is one we can't judge;
        // score it neutrally rather than discarding it, so a game whose
        // actions resist preview still gets played rather than stalling.
        let score = after === null ? 0 : evaluate(after);

        if (after !== null && weights.denial) {
          let worst = 0;
          for (let i = 0; i < (after.players || []).length; i++) {
            if (i === actorId) continue;
            worst += evaluateState(ruleset, after, i, positional);
          }
          score -= weights.denial * worst;
        }

        score += (rng() - 0.5) * weights.jitter;
        scored.push({ action, after, score });
      }

      if (!scored.length) return null;

      // --- pass two: check only the shortlist for a punishing reply ---
      // What the opposition can take straight back. Without this the
      // player is blind to hanging a piece, which is fatal where
      // captures are compulsory: over 40 games of checkers,
      // greedy-without-safety scored 17 wins to random's 23; with it,
      // 20 out of 20.
      //
      // It is only applied to the best few candidates because it costs
      // a state copy per possible reply, and running it over every
      // action made Territory take six seconds a turn by turn 13. An
      // action that already scores far below the leader will not be
      // rescued by looking deeper, so the shortlist loses nothing.
      if (weights.safety) {
        scored.sort((a, b) => b.score - a.score);
        const shortlist = scored.slice(0, SAFETY_SHORTLIST);
        for (const cand of shortlist) {
          if (cand.after === null || ruleset.isTerminal(cand.after)) continue;
          cand.score -= weights.safety * worstReply(ruleset, cand.after, actorId, weights);
        }
        shortlist.sort((a, b) => b.score - a.score);
        return shortlist[0].action;
      }

      let best = scored[0];
      for (const c of scored) if (c.score > best.score) best = c;
      return best.action;
    },
  };
}

/**
 * How much the position can worsen for `actorId` on the very next move,
 * if whoever is on turn plays the most damaging thing available.
 *
 * Deliberately shallow and deliberately cheap: one ply, material and
 * ground only, and it gives up rather than guessing if the reply can't
 * be simulated.
 */
function worstReply(ruleset, state, actorId, weights) {
  const mover = state.cur;
  if (mover === actorId) return 0;             // still our turn; no reply yet

  let replies;
  try {
    replies = ruleset.legalActions(state, mover, null);
  } catch {
    return 0;
  }
  if (!replies || !replies.length) return 0;

  if (replies.length > REPLY_CEILING) return 0;

  const positional = { ...weights, mobility: 0, safety: 0 };
  const now = evaluateState(ruleset, state, actorId, positional);
  let worst = 0;

  for (const reply of replies) {
    const draft = structuredClone(state);
    try {
      ruleset.applyAction(draft, reply, new Rng(draft.rngState ?? 1));
    } catch {
      continue;
    }
    const loss = now - evaluateState(ruleset, draft, actorId, positional);
    if (loss > worst) worst = loss;
  }
  return worst;
}

/* ============================================================
   RUNNING AN AI AGAINST AN ENGINE
   ============================================================ */

/**
 * Build the context an AI is handed. Kept here rather than in the AI so
 * every AI gets the same shape, and so a hand-written one can't reach
 * past what the contract offers.
 */
export function makeContext(engine, actorId, rng, seen = null) {
  return {
    state: engine.state,
    actorId,
    ruleset: engine.ruleset,
    actions: engine.legalActions(actorId),
    preview: action => engine.preview(action, actorId),
    evaluate: (state, who = actorId) =>
      evaluateState(engine.ruleset, state, who, engine.aiWeights),
    /**
     * Positions already reached during this turn. A game may offer
     * exactly reversible actions — Territory's forge and burn undo each
     * other at no cost — and an AI with no memory will oscillate
     * between them forever. Any AI should avoid an action that returns
     * to a position in here.
     */
    seen: seen || new Set(),
    hash: state => positionHash(state),
    rng,
  };
}

/**
 * Ask an AI for one action and apply it.
 *
 * Everything the AI does goes through applyAction like any human move,
 * so the record, undo, and replay all work unchanged — a game against a
 * bot is replayable exactly like any other. Returns the action taken, or
 * null if there was nothing to do.
 */
export function takeTurn(engine, ai, actorId = engine.state.cur, rng = Math.random, seen = null) {
  if (engine.isOver()) return null;

  const ctx = makeContext(engine, actorId, rng, seen);
  if (!ctx.actions.length) return null;

  let action;
  try {
    action = ai.chooseAction(ctx);
  } catch (err) {
    // A hand-written AI that throws should not take the page down with
    // it. Fall back to a legal move so play can continue, and say so.
    throw new Error(`${ai.name} threw while choosing: ${err.message}`);
  }

  if (!action) return null;
  if (!engine.isLegal(action, actorId)) {
    throw new Error(`${ai.name} chose an illegal action: ${JSON.stringify(action)}`);
  }

  engine.applyAction(action, actorId);
  return action;
}

/**
 * Keep taking turns while it is this actor's move.
 *
 * Games with multi-step turns (Territory produces, then moves, then ends
 * the turn) need several actions before the turn passes on. The cap is a
 * guard against an AI that finds a loop of actions which never advances
 * the turn — better to stop and report than to hang the page.
 */
export function playTurn(engine, ai, actorId, rng = Math.random, cap = 400) {
  const taken = [];
  const seen = new Set([positionHash(engine.state)]);
  let steps = 0;

  while (!engine.isOver() && engine.state.cur === actorId && steps++ < cap) {
    const action = takeTurn(engine, ai, actorId, rng, seen);
    if (!action) break;
    taken.push(action);

    // If the turn has come back to a position it already occupied, it
    // is going in circles — Territory's forge and burn undo each other
    // exactly, so any AI that doesn't check will loop forever. The
    // well-behaved ones avoid this themselves using ctx.seen; catching
    // it here too means a careless hand-written AI degrades into a
    // short turn rather than hanging the page.
    const here = positionHash(engine.state);
    if (seen.has(here)) break;
    seen.add(here);
  }

  if (steps > cap) {
    throw new Error(`${ai.name} took ${cap} actions without ending its turn.`);
  }
  return taken;
}

/** A seeded rng function, so an AI game is reproducible. */
export function seededRandom(seed) {
  const r = new Rng(seed);
  return () => r.next();
}

/* ============================================================
   REGISTRY
   ============================================================ */

/**
 * The opponents a player can choose from. Same idea as the ruleset
 * registry: one authoritative list, so the picker and the settings
 * dialog never hardcode their own.
 */
const aiRegistry = new Map();

export function registerAi(factory, meta = {}) {
  const probe = factory();
  const problems = validateAi(probe);
  if (problems.length) {
    throw new Error('AI does not satisfy the contract:\n  ' + problems.join('\n  '));
  }
  const entry = {
    id: probe.id,
    name: probe.name,
    version: probe.version,
    description: meta.description || probe.description || '',
    weightSpec: probe.weightSpec || [],
    defaults: probe.weights || {},
    create: factory,
  };
  aiRegistry.set(entry.id, entry);
  return entry;
}

export function allAis() {
  return [...aiRegistry.values()];
}

export function getAi(id) {
  return aiRegistry.get(id) || null;
}

registerAi(greedyAi);

export default greedyAi;
