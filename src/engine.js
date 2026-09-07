/* engine.js — the generic game runner.
 *
 * Knows about actors, actions, logs, undo, and fingerprints. Knows
 * nothing about any particular game: every question of "what may happen
 * next" and "what does that do" is delegated to a ruleset.
 *
 * The engine is the only thing that mutates state, and it does so only
 * through applyAction() — which is also the only place snapshots are
 * taken. That single chokepoint is what makes undo and replay reliable.
 */

import { Rng } from './rng.js';
import { hashState, firstDifference } from './hash.js';
import { validateRuleset, actionsEqual } from './ruleset-api.js';

export class Engine {
  /**
   * @param ruleset  an object satisfying ruleset-api.js
   * @param options  {config, seed, players, maxUndo}
   *
   * `players` is part of a game's identity, not something set afterwards:
   * a replayed or deserialized game must be reconstructible from options
   * plus an action list alone, so seating cannot happen off to the side.
   */
  constructor(ruleset, options = {}) {
    const problems = validateRuleset(ruleset);
    if (problems.length) {
      throw new Error('Invalid ruleset:\n  ' + problems.join('\n  '));
    }
    this.ruleset = ruleset;
    this.maxUndo = options.maxUndo ?? 200;

    // Config is a merge of ruleset defaults and whatever the table agreed
    // on, copied so edits here never reach back into the ruleset module.
    this.config = { ...structuredClone(ruleset.config), ...(options.config || {}) };
    this.seed = options.seed ?? 1;
    this.players = structuredClone(options.players || []);

    const rng = new Rng(this.seed);
    this.state = ruleset.createInitialState(this.config, rng, this.players);
    this.state.rngState = rng.state;
    this.state.actionCount = 0;

    this.log = [];
    this.history = [];   // [{action, before, hashAfter, logFrom}]
    this.listeners = new Set();
  }

  /* ---------- observation ---------- */

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  /**
   * Actions available to an actor right now. Never mutates.
   * `scope` is an optional narrowing hint the ruleset may honour or
   * ignore — see ruleset-api.js.
   */
  legalActions(actorId = this.state.cur, scope = null) {
    if (this.isOver()) return [];
    return this.ruleset.legalActions(this.state, actorId, scope) || [];
  }

  /** Is this action legal right now? Uses the ruleset's fast path if any. */
  isLegal(action, actorId = this.state.cur) {
    if (this.isOver()) return false;
    if (typeof this.ruleset.isLegal === 'function') {
      return !!this.ruleset.isLegal(this.state, action, actorId);
    }
    return this.legalActions(actorId, { action }).some(a => actionsEqual(a, action));
  }

  isOver() {
    return !!this.ruleset.isTerminal(this.state);
  }

  result() {
    return this.ruleset.isTerminal(this.state);
  }

  /** Fingerprint of the current state, excluding engine bookkeeping. */
  fingerprint() {
    return hashState(this.state);
  }

  snapshot() {
    return structuredClone(this.state);
  }

  /* ---------- the one mutation path ---------- */

  /**
   * Validate an action against the ruleset's own legal list, then apply
   * it. Throws on an illegal action rather than applying it — a bad
   * action from the UI is a bug, and a bad action off the network is a
   * desync we want to hear about loudly.
   *
   * @param action    a plain object from legalActions()
   * @param actorId   who is acting; defaults to whoever's turn it is
   */
  applyAction(action, actorId = this.state.cur) {
    if (this.isOver()) throw new Error('The game is already over.');

    if (!this.isLegal(action, actorId)) {
      throw new Error(`Illegal action for actor ${actorId}: ${JSON.stringify(action)}`);
    }

    const before = structuredClone(this.state);
    const logFrom = this.log.length;

    const rng = new Rng(this.state.rngState ?? this.seed);
    let entries;
    try {
      entries = this.ruleset.applyAction(this.state, action, rng) || [];
    } catch (err) {
      // A ruleset that throws mid-mutation may have left state half
      // changed; roll back rather than carrying the damage forward.
      this.state = before;
      throw new Error(`Ruleset threw while applying ${action.type}: ${err.message}`);
    }
    this.state.rngState = rng.state;
    this.state.actionCount = (this.state.actionCount || 0) + 1;

    for (const e of entries) {
      this.log.push(typeof e === 'string' ? { text: e, actorId } : { actorId, ...e });
    }

    this.history.push({ action, actorId, before, hashAfter: this.fingerprint(), logFrom });
    if (this.history.length > this.maxUndo) this.history.shift();

    this.emit();
    return { hash: this.fingerprint(), entries };
  }

  /**
   * Apply an action to a copy and hand back the resulting state, leaving
   * this engine untouched — no history, no log, no change notification.
   *
   * This is what lets an AI look before it leaps without the alternative
   * of "apply then undo", which would churn history and fire listeners
   * for moves nobody made. Returns null if the ruleset refuses or throws,
   * so a caller can treat "can't be previewed" as "not worth trying".
   */
  preview(action, actorId = this.state.cur) {
    if (this.isOver()) return null;
    if (!this.isLegal(action, actorId)) return null;
    const draft = structuredClone(this.state);
    const rng = new Rng(draft.rngState ?? this.seed);
    try {
      this.ruleset.applyAction(draft, action, rng);
    } catch {
      return null;
    }
    draft.rngState = rng.state;
    draft.actionCount = (draft.actionCount || 0) + 1;
    return draft;
  }

  /* ---------- undo ---------- */

  canUndo() {
    return this.history.length > 0;
  }

  /** Step back one action. */
  undo() {
    const last = this.history.pop();
    if (!last) return false;
    this.state = last.before;
    this.log.length = last.logFrom;
    this.emit();
    return true;
  }

  /**
   * Rewind to just before the nth action in history (0-based), dropping
   * everything after it. This is what a click on a log line does.
   */
  undoTo(index) {
    if (index < 0 || index >= this.history.length) return false;
    const target = this.history[index];
    this.state = target.before;
    this.log.length = target.logFrom;
    this.history.length = index;
    this.emit();
    return true;
  }

  /* ---------- serialization ---------- */

  /** Everything needed to rebuild this game elsewhere. */
  serialize() {
    return {
      rulesetId: this.ruleset.id,
      rulesetVersion: this.ruleset.version,
      config: this.config,
      seed: this.seed,
      players: this.players,
      state: this.state,
      log: this.log,
    };
  }

  static deserialize(ruleset, data) {
    const eng = new Engine(ruleset, {
      config: data.config, seed: data.seed, players: data.players,
    });
    eng.state = structuredClone(data.state);
    eng.log = structuredClone(data.log || []);
    eng.history = [];   // undo does not travel across a save
    return eng;
  }

  /**
   * Replay an action list from a fresh game. Used by tests, and by the
   * net layer to rebuild a match from its move history.
   */
  static replay(ruleset, { config, seed, players }, actions) {
    const eng = new Engine(ruleset, { config, seed, players });
    for (const { action, actorId } of actions) eng.applyAction(action, actorId);
    return eng;
  }
}

/**
 * Cross-validation for multiplayer, per ARCHITECTURE.md: apply the
 * opponent's claimed action against our own state with our own ruleset,
 * and compare fingerprints. A mismatch means the two sides are no longer
 * running the same rules — we report it in full rather than silently
 * trusting either side.
 *
 * The engine is left untouched when validation fails, so the caller can
 * pause the match with both versions intact for the players to look at.
 */
export function verifyRemoteAction(engine, packet) {
  const { action, actorId, hash: theirHash, state: theirState } = packet;

  const trial = Engine.deserialize(engine.ruleset, engine.serialize());
  let ourHash, error = null;
  try {
    ourHash = trial.applyAction(action, actorId).hash;
  } catch (err) {
    error = err.message;
  }

  if (error) {
    return {
      ok: false,
      reason: 'rejected',
      detail: error,
      action,
      actorId,
    };
  }
  if (ourHash !== theirHash) {
    return {
      ok: false,
      reason: 'diverged',
      action,
      actorId,
      ourHash,
      theirHash,
      // Both states go to the UI so the two players can see what
      // disagreed — transparency over obscurity, friends-only trust.
      ourState: trial.state,
      theirState: theirState ?? null,
      difference: theirState ? firstDifference(trial.state, theirState) : null,
    };
  }

  engine.applyAction(action, actorId);
  return { ok: true, hash: ourHash };
}
