/* match.test.js — two machines playing one game.
 *
 * Everything here runs without a network. The paired transport is two
 * matches wired together in one process, which is enough to exercise
 * seat gating, move exchange, catch-up, and every way the two sides can
 * fall out of agreement.
 *
 * The point of testing this before a relay exists: when the relay
 * arrives it is a transport and nothing more, and these tests should
 * still pass unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getRuleset } from '../rulesets/index.js';
import {
  Match, hostMatch, joinMatch, pairedTransports, manualTransport,
  encodeInvite, decodeInvite, encodeMove, decodeMove, rulesPin,
} from '../src/match.js';

const PLAYERS = [
  { name: 'Ada', colors: { primary: '#E7EDE9', accent: '#C8A24A' } },
  { name: 'Bo', colors: { primary: '#2C3A38', accent: '#7A6430' } },
];

/** A hosted-and-joined pair, already wired together. */
function table(rulesetId = 'hexapawn', config = {}) {
  const entry = getRuleset(rulesetId);
  const [t1, t2] = pairedTransports();
  const { match: host, invite } = hostMatch({
    entry, config, players: PLAYERS, seed: 42, transport: t1,
  });
  const { match: guest } = joinMatch(invite, { transport: t2 });
  return { host, guest, invite, entry };
}

/* ---------- the invitation ---------- */

test('an invitation survives a round trip', () => {
  const { invite } = table();
  const d = decodeInvite(invite);
  assert.equal(d.rulesetId, 'hexapawn');
  assert.equal(d.seed, 42);
  assert.equal(d.players.length, 2);
});

test('an invitation carries no board, only what one can be derived from', () => {
  const { invite } = table();
  const d = decodeInvite(invite);
  // The whole design rests on (ruleset, config, seed, players, actions).
  // Shipping a board would mean the invitation could disagree with what
  // the rules actually produce.
  assert.equal(d.board, undefined);
  assert.equal(d.state, undefined);
});

test('a mangled invitation is refused with a readable reason', () => {
  assert.throws(() => decodeInvite('not-a-real-code'), /./);
  assert.throws(() => decodeInvite(encodeInvite({ rulesetId: 'x' })), /seed/);
});

test('both sides build the same opening position', () => {
  // Including Territory, whose opening is randomly scattered — the
  // seeded rng is what makes that safe to derive rather than send.
  for (const id of ['hexapawn', 'chess', 'territory']) {
    const { host, guest } = table(id, id === 'territory' ? { scatterStacks: 3 } : {});
    assert.equal(host.engine.fingerprint(), guest.engine.fingerprint(),
      `${id}: the two sides started from different positions`);
  }
});

/* ---------- seats ---------- */

test('each side owns only its own seat', () => {
  const { host, guest } = table();
  assert.ok(host.isLocalSeat(0));
  assert.ok(!host.isLocalSeat(1));
  assert.ok(guest.isLocalSeat(1));
  assert.ok(!guest.isLocalSeat(0));
});

test('only the side whose turn it is may move', () => {
  const { host, guest } = table();
  assert.ok(host.canAct(), 'the host moves first');
  assert.ok(!guest.canAct(), 'the guest must wait');
  assert.match(guest.waitingOn(), /Waiting for Ada/);
});

test('playing out of turn is refused', () => {
  const { guest } = table();
  const action = guest.engine.legalActions(0)[0];
  assert.throws(() => guest.act(action, 0), /not yours to play/);
  assert.equal(guest.engine.history.length, 0, 'and nothing was applied');
});

/* ---------- playing ---------- */

test('a move made on one side arrives on the other', () => {
  const { host, guest } = table();
  const action = host.engine.legalActions(0)[0];
  host.act(action);

  assert.equal(guest.engine.history.length, 1, 'the guest should have it');
  assert.equal(host.engine.fingerprint(), guest.engine.fingerprint());
  assert.ok(guest.canAct(), 'and it is now their turn');
  assert.ok(!host.canAct());
});

test('a whole game stays in step', () => {
  const { host, guest } = table();
  let turns = 0;

  while (!host.engine.isOver() && turns++ < 40) {
    const side = host.canAct() ? host : guest;
    const actions = side.engine.legalActions(side.engine.state.cur);
    if (!actions.length) break;
    side.act(actions[0]);
    assert.equal(host.engine.fingerprint(), guest.engine.fingerprint(),
      `the two sides drifted apart on turn ${turns}`);
  }

  assert.ok(turns > 2, 'the game should have actually been played');
  assert.equal(host.status, guest.status);
});

test('both sides notice the game ending', () => {
  const { host, guest } = table();
  let turns = 0;
  while (!host.engine.isOver() && turns++ < 60) {
    const side = host.canAct() ? host : guest;
    const actions = side.engine.legalActions(side.engine.state.cur);
    if (!actions.length) break;
    side.act(actions[0]);
  }
  if (host.engine.isOver()) {
    assert.equal(host.status, 'over');
    assert.equal(guest.status, 'over');
    assert.equal(host.canAct(), false);
  }
});

/* ---------- when the two sides disagree ---------- */

test('a tampered move is caught and the match freezes', () => {
  const entry = getRuleset('hexapawn');
  const [t1] = pairedTransports();
  const { match: host, invite } = hostMatch({
    entry, players: PLAYERS, seed: 42, transport: t1,
  });
  const { match: guest } = joinMatch(invite);

  const action = host.engine.legalActions(0)[0];
  const seq = host.engine.history.length;
  host.engine.applyAction(action, 0);

  // A move claiming a result that isn't the one those rules produce.
  guest.receive({
    type: 'action', seq, action, actorId: 0, hash: 'not-the-real-hash', pin: host.pin,
  });

  assert.equal(guest.status, 'diverged');
  assert.equal(guest.canAct(), false, 'a frozen match takes no more moves');

  const report = guest.divergenceReport();
  assert.match(report.headline, /disagree/);
  // Transparency over obscurity: both versions are laid out.
  assert.ok(report.ourHash && report.theirHash);
  assert.notEqual(report.ourHash, report.theirHash);
});

test('an illegal move is refused rather than applied', () => {
  const { host, guest } = table();
  guest.receive({
    type: 'action', seq: 0,
    action: { type: 'move', x: 9, y: 9, tx: 9, ty: 8 },
    actorId: 0, hash: 'whatever', pin: host.pin,
  });
  assert.equal(guest.status, 'diverged');
  assert.equal(guest.engine.history.length, 0, 'nothing was applied');
  assert.match(guest.divergenceReport().headline, /refused/);
});

test('different rules are caught before a move is even checked', () => {
  // The failure this prevents is nasty: with edited rules every single
  // move diverges, and the log fills with disagreements that look like
  // bugs rather than like the one cause they share.
  const { guest, host } = table();
  guest.receive({
    type: 'action', seq: 0,
    action: host.engine.legalActions(0)[0],
    actorId: 0, hash: 'x', pin: 'a-different-pin',
  });
  assert.equal(guest.status, 'diverged');
  assert.match(guest.divergenceReport().headline, /different rules/i);
});

test('joining with edited rules is refused up front', () => {
  const entry = getRuleset('hexapawn');
  const { invite } = hostMatch({
    entry, players: PLAYERS, seed: 1, sourceText: 'the original source',
  });
  assert.throws(
    () => joinMatch(invite, { sourceText: 'source with a tweak' }),
    /differs from the host/,
  );
});

test('the rules pin notices a changed setting', () => {
  const entry = getRuleset('hexapawn');
  assert.notEqual(rulesPin(entry, { size: 3 }), rulesPin(entry, { size: 5 }));
  assert.equal(rulesPin(entry, { size: 3 }), rulesPin(entry, { size: 3 }));
});

test('a missing ruleset is reported by name', () => {
  const invite = encodeInvite({ rulesetId: 'snakes-and-ladders', seed: 1, players: PLAYERS });
  assert.throws(() => joinMatch(invite), /snakes-and-ladders/);
});

/* ---------- falling behind ---------- */

test('a move arriving out of order triggers a catch-up', () => {
  // Deliberately unconnected: with a live transport the stall heals
  // itself immediately, because the sync round trip completes before
  // this line runs. Here we want to observe the stall itself.
  const entry = getRuleset('hexapawn');
  const { match: host, invite } = hostMatch({ entry, players: PLAYERS, seed: 42 });
  const { match: guest } = joinMatch(invite);

  guest.receive({
    type: 'action', seq: 5,          // we are nowhere near move five
    action: host.engine.legalActions(0)[0], actorId: 0, hash: 'x', pin: host.pin,
  });

  assert.equal(guest.status, 'stalled', 'it should not guess at what it missed');
  assert.equal(guest.engine.history.length, 0, 'and apply nothing meanwhile');
  const asked = guest.drain();
  assert.equal(asked[0]?.type, 'sync-request', 'it should ask for the missing moves');
});

test('a stall heals itself when the two sides are connected', () => {
  const { host, guest } = table();
  for (let i = 0; i < 2; i++) {
    const side = host.engine.state.cur;
    host.engine.applyAction(host.engine.legalActions(side)[0], side);   // silently
  }
  // Now send a move the guest cannot possibly have the lead-up to.
  const cur = host.engine.state.cur;
  const action = host.engine.legalActions(cur)[0];
  const seq = host.engine.history.length;
  const { hash } = host.engine.applyAction(action, cur);
  guest.receive({ type: 'action', seq, action, actorId: cur, hash, pin: host.pin });

  assert.notEqual(guest.status, 'diverged', 'a gap is not a disagreement');
  assert.equal(guest.engine.fingerprint(), host.engine.fingerprint(),
    'the catch-up should land it on the same position');
});

test('a side that fell behind can be brought up to date', () => {
  // Chess rather than hexapawn: three moves of hexapawn can finish the
  // game, and this test is about the catch-up, not the ending.
  const entry = getRuleset('chess');
  const { match: host, invite } = hostMatch({ entry, players: PLAYERS, seed: 42 });
  const { match: guest } = joinMatch(invite);

  // Host plays three moves into the void.
  for (let i = 0; i < 3; i++) {
    const side = host.engine.state.cur;
    host.engine.applyAction(host.engine.legalActions(side)[0], side);
  }
  assert.equal(guest.engine.history.length, 0);

  guest.receive({
    type: 'sync',
    pin: host.pin,
    actions: host.engine.history.map(h => ({ action: h.action, actorId: h.actorId })),
  });

  assert.equal(guest.engine.history.length, 3);
  assert.equal(guest.engine.fingerprint(), host.engine.fingerprint(),
    'catching up should land on exactly the same position');
  assert.equal(guest.status, 'playing');
  assert.equal(guest.divergence, null, 'and it is not treated as a disagreement');
});

test('a bad catch-up leaves the live game alone', () => {
  const { guest } = table();
  const before = guest.engine.fingerprint();
  guest.receive({
    type: 'sync',
    actions: [{ action: { type: 'move', x: 9, y: 9, tx: 0, ty: 0 }, actorId: 0 }],
  });
  assert.equal(guest.status, 'diverged');
  assert.equal(guest.engine.fingerprint(), before,
    'a rejected catch-up must not half-apply');
});

test('a duplicated move is ignored rather than played twice', () => {
  const { host, guest } = table();
  const action = host.engine.legalActions(0)[0];
  host.act(action);
  const count = guest.engine.history.length;

  guest.receive({ type: 'action', seq: 0, action, actorId: 0, hash: 'x', pin: host.pin });
  assert.equal(guest.engine.history.length, count, 'the repeat was dropped');
  assert.equal(guest.status, 'playing', 'and it is not treated as a disagreement');
});

/* ---------- transports ---------- */

test('a match with no transport queues its moves for a human to carry', () => {
  // This is the copy-and-paste game, and the proof that the layer does
  // not care what the channel is.
  const entry = getRuleset('hexapawn');
  const { match: host, invite } = hostMatch({ entry, players: PLAYERS, seed: 42 });
  const { match: guest } = joinMatch(invite);

  host.act(host.engine.legalActions(0)[0]);
  const pending = host.drain();
  assert.equal(pending.length, 1, 'the move should be waiting to be carried');

  guest.receive(pending[0]);
  assert.equal(guest.engine.fingerprint(), host.engine.fingerprint());
  assert.equal(host.drain().length, 0, 'and the queue empties once taken');
});

test('a move survives being carried as a pasted code', () => {
  const entry = getRuleset('hexapawn');
  const t = manualTransport();
  const { match: host, invite } = hostMatch({ entry, players: PLAYERS, seed: 42, transport: t });
  const { match: guest } = joinMatch(invite);

  host.act(host.engine.legalActions(0)[0]);
  const codes = t.take();
  assert.equal(codes.length, 1);
  assert.equal(typeof codes[0], 'string');

  guest.receive(decodeMove(codes[0]));
  assert.equal(guest.engine.fingerprint(), host.engine.fingerprint());
});

test('a move code round-trips exactly', () => {
  const packet = { type: 'action', seq: 3, action: { type: 'move', x: 1, y: 2, tx: 1, ty: 3 }, actorId: 0, hash: 'abc' };
  assert.deepEqual(decodeMove(encodeMove(packet)), packet);
});

test('resigning ends the match on both sides', () => {
  const { host, guest } = table();
  host.resign();
  assert.equal(host.status, 'over');
  assert.equal(guest.status, 'over');
  assert.equal(guest.resigned, 0);
});

/* ---------- the layer stays generic ---------- */

test('the match layer names no particular game', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../src/match.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['chess', 'checkers', 'territory', 'armory', 'pawn']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(code),
      `match.js mentions "${word}" in code — a match should work for any game`);
  }
});

test('a change notification fires on both sides', () => {
  const { host, guest } = table();
  let hostSaw = 0, guestSaw = 0;
  host.onChange(() => hostSaw++);
  guest.onChange(() => guestSaw++);
  host.act(host.engine.legalActions(0)[0]);
  assert.ok(hostSaw > 0, 'the mover should be told');
  assert.ok(guestSaw > 0, 'and so should the receiver');
});

/* ---------- what a match forbids ---------- */

test('a match refuses a move from the seat that is not yours', () => {
  // The UI gates on canAct(), but the layer has to refuse it too — a
  // gate that only exists in the interface is not a rule.
  const { host, guest } = table();
  const action = host.engine.legalActions(0)[0];
  host.act(action);
  assert.throws(() => host.act(host.engine.legalActions(1)[0], 1), /not yours to play/);
});

test('a frozen match takes no further moves from either side', () => {
  const { host, guest } = table();
  guest.receive({
    type: 'action', seq: 0,
    action: host.engine.legalActions(0)[0], actorId: 0, hash: 'wrong', pin: host.pin,
  });
  assert.equal(guest.status, 'diverged');
  assert.throws(() => guest.act(guest.engine.legalActions(1)[0], 1), /diverged/);
});
