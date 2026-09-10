/* match.js — a game played between two machines.
 *
 * This layer knows nothing about *how* the two sides talk. It takes a
 * transport — an object with send() and onMessage() — and handles
 * everything above it: agreeing on the game, gating whose turn it is,
 * sending moves, verifying the ones that arrive, catching up after a
 * gap, and freezing the match if the two sides ever disagree.
 *
 * Written before any server exists, deliberately. A relay is a transport
 * and nothing more; so is copying a code into a chat window. Building
 * the match layer first means the relay, when it comes, is a swap rather
 * than a rewrite — and it means all of this can be tested without a
 * network at all.
 *
 * -----------------------------------------------------------
 * WHAT MAKES IT WORK
 * -----------------------------------------------------------
 *
 * A game is fully described by (ruleset, config, seed, players,
 * actions). That invariant is the whole design. It means:
 *
 *   - The invite only has to carry the first four. Both sides build an
 *     identical opening position from it, including Territory's random
 *     scatter, because the rng is seeded.
 *   - A move on the wire is just an action. No board state, no diffs.
 *   - Anyone can rebuild the game from the action list, which is what
 *     reconnecting after a dropped connection amounts to.
 *
 * -----------------------------------------------------------
 * TRUST
 * -----------------------------------------------------------
 *
 * This is not an anti-cheat system and does not try to be. It is built
 * for playing with people you know. Each side replays the other's move
 * against its own copy of the rules and compares fingerprints; if they
 * disagree, the match stops and shows both versions to both players.
 * The assumption is that a mismatch is a bug or a stale ruleset, not an
 * attack — so the response is to show everyone everything rather than
 * to pick a winner.
 */

import { Engine, verifyRemoteAction } from './engine.js';
import { hashState } from './hash.js';
import { getRuleset } from '../rulesets/index.js';
import { pack, unpack } from './codec.js';

/* ============================================================
   ENCODING
   ============================================================ */

/**
 * The invitation: everything needed to build the same opening position.
 *
 * Deliberately small — it has to survive being pasted into a chat
 * window. No board state, because both sides can derive it.
 */
export function encodeInvite(descriptor) {
  return pack(descriptor);
}

export function decodeInvite(code) {
  const d = unpack(code, 'invitation');
  for (const field of ['rulesetId', 'seed', 'players']) {
    if (d[field] === undefined) throw new Error(`This invitation is missing its ${field}.`);
  }
  return d;
}

/** A move on the wire. */
export function encodeMove(packet) {
  return pack(packet);
}

export function decodeMove(code) {
  const p = unpack(code, 'move code');
  if (p.type === undefined) p.type = 'action';
  return p;
}

/* ============================================================
   PINNING
   ============================================================ */

/**
 * A fingerprint of the rules being played.
 *
 * Rulesets are editable here, which is a feature in single player and a
 * hazard in a match: if one side has tweaked a cost, every move diverges
 * and the log fills with disagreements that look like bugs. So the rules
 * are pinned at the start and checked on joining.
 *
 * Hashing the source text is the strict version and catches everything.
 * When the source isn't to hand — a ruleset registered from memory — it
 * falls back to identity and config, which catches the common cases
 * (different version, different settings) and not a silent edit.
 */
export function rulesPin(entry, config, sourceText = null) {
  return hashState({
    id: entry.ruleset.id,
    version: entry.ruleset.version,
    config,
    source: sourceText ? hashState(sourceText) : null,
    strict: !!sourceText,
  });
}

/* ============================================================
   THE MATCH
   ============================================================ */

/**
 * Statuses a match can be in:
 *
 *   'playing'   normal
 *   'diverged'  the two sides disagree; frozen, showing both versions
 *   'stalled'   a move arrived out of order and we asked for a catch-up
 *   'over'      the game finished
 */
export class Match {
  /**
   * @param options
   *   entry        registry entry for the ruleset
   *   config       settings, pinned for the match
   *   seed         shared rng seed
   *   players      seats, in order
   *   localSeats   which seat numbers this machine controls
   *   transport    { send(message), onMessage(handler) } — optional;
   *                without one, outgoing messages queue up for the
   *                caller to carry by hand
   *   pin          the rules fingerprint both sides agreed on
   */
  constructor(options) {
    const {
      entry, config = {}, seed = 1, players = [],
      localSeats = [0], transport = null, pin = null,
    } = options;

    this.entry = entry;
    this.pin = pin;
    this.localSeats = new Set(localSeats);
    this.status = 'playing';
    this.divergence = null;
    this.outbox = [];              // messages waiting to be carried
    this.listeners = [];

    this.engine = new Engine(entry.ruleset, { config, seed, players });
    this.engine.onChange(() => this.emit());

    this.transport = null;
    if (transport) this.attach(transport);
  }

  /* ---------- wiring ---------- */

  attach(transport) {
    this.transport = transport;
    if (typeof transport.onMessage === 'function') {
      transport.onMessage(msg => this.receive(msg));
    }
    // Anything queued while there was no transport goes out now.
    const queued = this.outbox.splice(0);
    for (const msg of queued) this.send(msg);
  }

  onChange(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(f => f !== fn); };
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  send(message) {
    if (!this.transport) {
      // No channel: hold it so the caller can hand it over by other
      // means. This is what makes a copy-and-paste game possible.
      this.outbox.push(message);
      return message;
    }
    this.transport.send(message);
    return message;
  }

  /** Messages waiting to be carried by hand, and clear the queue. */
  drain() {
    return this.outbox.splice(0);
  }

  /* ---------- whose turn ---------- */

  isLocalSeat(seatId) {
    return this.localSeats.has(seatId);
  }

  /** May this machine act right now? */
  canAct() {
    return this.status === 'playing'
      && !this.engine.isOver()
      && this.isLocalSeat(this.engine.state.cur);
  }

  /** Something a player would want to read: why they cannot move. */
  waitingOn() {
    if (this.status === 'diverged') return 'The two sides disagree — the match is paused.';
    if (this.status === 'stalled') return 'Waiting for missing moves.';
    if (this.engine.isOver()) return null;
    if (this.canAct()) return null;
    const who = this.engine.players[this.engine.state.cur];
    return `Waiting for ${who?.name || 'the other player'}.`;
  }

  /* ---------- making a move ---------- */

  /**
   * Play a local action: apply it here, then tell the other side.
   *
   * The action is applied locally first and the resulting fingerprint
   * travels with it. That is what the other side checks against — they
   * replay the same action and compare. Sending the fingerprint rather
   * than the board keeps the message small and still catches everything.
   */
  act(action, actorId = this.engine.state.cur) {
    if (this.status !== 'playing') {
      throw new Error(`The match is ${this.status}; no moves can be made.`);
    }
    if (!this.isLocalSeat(actorId)) {
      throw new Error(`Seat ${actorId} is not yours to play.`);
    }

    const seq = this.engine.history.length;
    const { hash } = this.engine.applyAction(action, actorId);

    this.send({
      type: 'action',
      seq,
      action,
      actorId,
      hash,
      pin: this.pin,
    });

    this.checkOver();
    return hash;
  }

  /* ---------- receiving ---------- */

  receive(message) {
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'action': return this.receiveAction(message);
      case 'sync-request': return this.sendHistory();
      case 'sync': return this.receiveHistory(message);
      case 'resign': return this.receiveResign(message);
      default: return undefined;
    }
  }

  receiveAction(packet) {
    if (this.status === 'diverged') return;

    if (packet.pin && this.pin && packet.pin !== this.pin) {
      // Different rules on the two sides. Every move would diverge, and
      // the cause would be invisible, so say the real reason once.
      this.status = 'diverged';
      this.divergence = {
        reason: 'rules',
        detail: 'The two sides are not running the same ruleset or settings.',
        theirPin: packet.pin,
        ourPin: this.pin,
      };
      this.emit();
      return;
    }

    const expected = this.engine.history.length;

    if (packet.seq < expected) return;            // already have it
    if (packet.seq > expected) {
      // A move went missing. Ask for the whole action list rather than
      // trying to guess what we skipped.
      this.status = 'stalled';
      this.send({ type: 'sync-request', have: expected });
      this.emit();
      return;
    }

    const result = verifyRemoteAction(this.engine, packet);

    if (!result.ok) {
      this.status = 'diverged';
      this.divergence = result;
      this.emit();
      return;
    }

    this.checkOver();
  }

  /** Hand over the whole game so far, for a side that fell behind. */
  sendHistory() {
    this.send({
      type: 'sync',
      pin: this.pin,
      actions: this.engine.history.map(h => ({ action: h.action, actorId: h.actorId })),
    });
  }

  /**
   * Rebuild from an action list.
   *
   * Replayed into a scratch engine first: if the list is bad, the live
   * game is untouched and we say so, rather than half-applying it and
   * ending up somewhere neither side recognises.
   */
  receiveHistory(message) {
    const actions = message.actions || [];
    if (actions.length <= this.engine.history.length) {
      this.status = this.engine.isOver() ? 'over' : 'playing';
      this.emit();
      return;
    }

    let rebuilt;
    try {
      rebuilt = Engine.replay(
        this.entry.ruleset,
        {
          config: this.engine.config,
          seed: this.engine.seed,
          players: this.engine.players,
        },
        actions,
      );
    } catch (err) {
      this.status = 'diverged';
      this.divergence = { reason: 'rejected', detail: `Catch-up failed: ${err.message}` };
      this.emit();
      return;
    }

    this.engine = rebuilt;
    this.engine.onChange(() => this.emit());
    this.status = 'playing';
    this.checkOver();
    this.emit();
  }

  /** Ask the other side for anything we have missed. */
  requestSync() {
    this.send({ type: 'sync-request', have: this.engine.history.length });
  }

  resign(actorId = [...this.localSeats][0]) {
    this.send({ type: 'resign', actorId });
    this.resigned = actorId;
    this.status = 'over';
    this.emit();
  }

  receiveResign(message) {
    this.resigned = message.actorId;
    this.status = 'over';
    this.emit();
  }

  checkOver() {
    if (this.engine.isOver()) this.status = 'over';
  }

  /* ---------- what a divergence looks like ---------- */

  /**
   * A plain-language account of a disagreement, for showing both
   * players. Transparency over obscurity: neither side is assumed to be
   * lying, so both versions are laid out and the humans decide.
   */
  divergenceReport() {
    if (!this.divergence) return null;
    const d = this.divergence;

    if (d.reason === 'rules') {
      return {
        headline: 'The two sides are playing different rules.',
        detail: 'One of you has edited the ruleset, changed a setting, or is on '
          + 'a different version. Start a fresh match from the same invitation.',
        difference: null,
      };
    }
    if (d.reason === 'rejected') {
      return {
        headline: 'That move was refused here.',
        detail: d.detail || 'Your copy of the rules does not allow it.',
        difference: null,
      };
    }
    return {
      headline: 'The two sides disagree about the result of that move.',
      detail: 'Both versions are shown below. This usually means one side is '
        + 'running edited rules, not that anyone is cheating.',
      action: d.action,
      actorId: d.actorId,
      ourHash: d.ourHash,
      theirHash: d.theirHash,
      difference: d.difference,
    };
  }
}

/* ============================================================
   STARTING ONE
   ============================================================ */

/**
 * Host a match: build the game and the invitation to go with it.
 *
 * The host takes seat 0 by default. The invitation carries no board,
 * only the four things a position can be derived from.
 */
export function hostMatch({
  entry, config = {}, players = [], seed = null,
  hostSeat = 0, transport = null, sourceText = null,
}) {
  const chosenSeed = seed ?? Math.floor(Math.random() * 2 ** 31);

  const match = new Match({
    entry, config, seed: chosenSeed, players,
    localSeats: [hostSeat], transport, pin: null,
  });

  // Pin on the *effective* config — the settings given, merged over the
  // ruleset's own defaults — not on what was passed in. Two sides can
  // pass the same partial settings and still end up playing differently
  // if their copies of the ruleset have different defaults, and that is
  // exactly the case a pin exists to catch.
  const pin = rulesPin(entry, match.engine.config, sourceText);
  match.pin = pin;

  const invite = encodeInvite({
    rulesetId: entry.ruleset.id,
    rulesetVersion: entry.ruleset.version,
    config,
    seed: chosenSeed,
    players,
    pin,
    hostSeat,
  });

  return { match, invite };
}

/**
 * Join a match from an invitation.
 *
 * The joiner rebuilds the identical opening position from the same four
 * things, then checks that the rules fingerprint agrees before a single
 * move is played — far better than discovering it mid-game.
 */
export function joinMatch(code, { transport = null, sourceText = null, lookup = getRuleset } = {}) {
  const d = decodeInvite(code);
  const entry = lookup(d.rulesetId);
  if (!entry) {
    throw new Error(`You don't have the ruleset "${d.rulesetId}".`);
  }

  const seats = (d.players || []).map((_, i) => i).filter(i => i !== (d.hostSeat ?? 0));

  const match = new Match({
    entry,
    config: d.config || {},
    seed: d.seed,
    players: d.players,
    localSeats: seats.length ? [seats[0]] : [1],
    transport,
    pin: null,
  });

  // Compared on the effective config, for the reason given in hostMatch.
  const ourPin = rulesPin(entry, match.engine.config, sourceText);
  if (d.pin && ourPin !== d.pin) {
    throw new Error(
      'Your copy of these rules differs from the host\'s. '
      + 'One of you has edited the ruleset or changed a setting.',
    );
  }
  match.pin = d.pin || ourPin;

  return { match, descriptor: d };
}

/* ============================================================
   TRANSPORTS
   ============================================================ */

/**
 * Two matches in one process, wired together. Not a toy: this is how the
 * whole layer is tested without a network, and it is the reference for
 * what a real transport has to do.
 */
export function pairedTransports() {
  const a = { handlers: [], other: null };
  const b = { handlers: [], other: null };
  a.other = b;
  b.other = a;

  const make = side => ({
    send(message) {
      // Cloned, because a real channel serializes: passing a live object
      // reference would hide bugs where one side mutates the other's.
      const copy = JSON.parse(JSON.stringify(message));
      for (const h of side.other.handlers) h(copy);
    },
    onMessage(handler) {
      side.handlers.push(handler);
    },
  });

  return [make(a), make(b)];
}

/**
 * A transport that carries nothing: messages pile up for a human to copy
 * across. The match layer cannot tell the difference, which is the
 * point — a relay will not be able to either.
 */
export function manualTransport() {
  let handler = null;
  const queue = [];
  return {
    send(message) { queue.push(message); },
    onMessage(fn) { handler = fn; },
    /** Codes waiting to be sent, cleared as they are taken. */
    take() { return queue.splice(0).map(encodeMove); },
    /** Feed in a code that arrived by other means. */
    deliver(code) {
      if (handler) handler(decodeMove(code));
    },
  };
}
