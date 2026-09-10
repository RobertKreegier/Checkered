/* ui.test.js — the interaction loop, headless.
 *
 * main.js claims one interaction model works for every game: click a
 * piece, click a target, and disambiguate only when a square affords
 * more than one action. That claim is worth testing, because it's the
 * thing most likely to quietly become "works for chess, sort of works
 * for Territory".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { Engine } from '../root/src/engine.js';
import { allRulesets, getRuleset } from '../root/rulesets/index.js';

function setupDom() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="app"><div id="boardwrap"><button id="zin"></button>
    <button id="zout"></button><button id="zhome"></button></div>
    <aside id="panel">
      <h1 class="wordmark" id="wordmark">Checkered <span id="gamename"></span></h1>
      <div id="pbody"></div><div id="pfoot"></div></aside></div>
    <div class="veil" id="veil"><div class="modal" id="modal"></div></div>
  </body></html>`, { pretendToBeVisual: true, url: 'https://example.test/' });

  global.window = dom.window;
  global.document = dom.window.document;
  global.localStorage = dom.window.localStorage;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0);

  const wrap = dom.window.document.getElementById('boardwrap');
  wrap.getBoundingClientRect = () => ({
    width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0,
  });
  return dom;
}

const OPENINGS = {
  territory: [
    { action: { type: 'place', x: 0, y: 0 }, actorId: 0 },
    { action: { type: 'place', x: 9, y: 2 }, actorId: 1 },
  ],
};

function gameFor(id) {
  // A "-fresh" suffix skips the opening actions, so a test can watch the
  // placement phase itself rather than the game that follows it.
  const fresh = id.endsWith('-fresh');
  if (fresh) id = id.slice(0, -'-fresh'.length);
  const entry = getRuleset(id);
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, Math.max(2, entry.minPlayers)),
    config: id === 'territory' ? { scatterStacks: 1 } : {},
    seed: 3,
  });
  if (!fresh) {
    for (const { action, actorId } of OPENINGS[id] || []) eng.applyAction(action, actorId);
  }
  return { eng, entry };
}

/** Boot main.js against a live engine, bypassing the picker. */
async function mountUI(id) {
  setupDom();
  // A fresh module per mount: main.js caches DOM references, and a
  // cached module would hold nodes from a previous test's document.
  const main = await import(`../root/src/main.js?ui=${id}&t=${Math.random()}`);
  const { UI } = main;
  const { BoardView } = await import('../root/src/board.js');
  const { eng, entry } = gameFor(id);

  UI.engine = eng;
  UI.entry = entry;
  UI.selected = null;
  UI.pendingTargets = null;
  UI.lastMove = null;
  UI.board = new BoardView(document.getElementById('boardwrap'), {
    onCellClick: main.onCellClick,
  });
  // Mirror what startGame() wires up, so the fixture exercises the same
  // path the real one does rather than a simplified version of it.
  eng.onChange(() => main.touchAutosave());
  UI.board.attach(eng);
  return { main, UI, eng };
}

for (const entry of allRulesets()) {
  test(`${entry.name}: selecting a piece reveals targets, clicking one acts`, async () => {
    const { main, UI, eng } = await mountUI(entry.id);
    const actions = main.currentActions();

    // Two shapes of game: one where a piece travels between squares, and
    // one where something simply appears on a square. Both have to work
    // through the same interaction, which is the point being tested.
    const step = actions.find(a => a.from && a.to &&
      !(a.from.x === a.to.x && a.from.y === a.to.y))
      || actions.find(a => !a.from && a.to);
    assert.ok(step, `${entry.name} offered no action pointing at a square`);

    const before = eng.fingerprint();
    const actionCount = eng.history.length;

    if (step.from) {
      main.onCellClick(step.from, {});
      assert.deepEqual(UI.selected, step.from, 'the click selected the origin');
    }

    main.onCellClick(step.to, {});

    // Either it applied, or it asked which of several actions was meant.
    if (UI.pendingTargets) {
      assert.ok(UI.pendingTargets.length > 1, 'only ambiguity should defer the move');
      assert.equal(eng.fingerprint(), before, 'nothing happens until it is resolved');
      UI.pendingTargets = null;
    } else {
      assert.equal(eng.history.length, actionCount + 1, 'exactly one action was applied');
      assert.notEqual(eng.fingerprint(), before);
    }
  });

  test(`${entry.name}: inspecting never changes the game`, async () => {
    const { main, UI, eng } = await mountUI(entry.id);
    const step = main.currentActions().find(a => a.to);
    assert.ok(step, `${entry.name} offered no action pointing at a square`);
    const before = eng.fingerprint();
    const acted = eng.history.length;   // openings already count as actions

    if (step.from) main.onCellClick(step.from, { inspect: true });
    main.onCellClick(step.to, { inspect: true });

    assert.equal(eng.fingerprint(), before, 'inspect must be read-only');
    assert.equal(eng.history.length, acted, 'no new action was recorded');
    assert.ok(UI.selected, 'but it does move the selection');
  });

  test(`${entry.name}: the panel renders without throwing`, async () => {
    const { main } = await mountUI(entry.id);
    main.UI.selected = main.currentActions()[0]?.from || null;
    // refresh() is called through the engine's change hook; drive it directly.
    main.onCellClick({ x: 99, y: 99 }, { inspect: true });
    const body = document.getElementById('pbody').innerHTML;
    assert.ok(body.length > 50, 'the panel drew nothing');
    assert.ok(document.getElementById('pfoot').innerHTML.includes('Undo'));
  });
}

test('an ambiguous square offers a choice, and picking one applies it', async () => {
  // A chess promotion is the clearest case: four actions, one square.
  setupDom();
  const main = await import('../root/src/main.js?promo&t=' + Math.random());
  const { BoardView } = await import('../root/src/board.js');
  const chess = getRuleset('chess');
  const eng = new Engine(chess.ruleset, {
    players: chess.defaultPlayers,
    config: { fen: '4k3/P7/8/8/8/8/8/4K3 w - - 0 1' },
  });

  main.UI.engine = eng;
  main.UI.entry = chess;
  main.UI.selected = null;
  main.UI.pendingTargets = null;
  main.UI.board = new BoardView(document.getElementById('boardwrap'), {
    onCellClick: main.onCellClick,
  });
  main.UI.board.attach(eng);

  main.onCellClick({ x: 0, y: 6 }, {});
  main.onCellClick({ x: 0, y: 7 }, {});

  assert.ok(main.UI.pendingTargets, 'four promotions should ask which');
  assert.equal(main.UI.pendingTargets.length, 4);
  assert.ok(main.UI.pendingTargets.every(a => a.label.startsWith('Promote')));

  const knight = main.UI.pendingTargets.find(a => a.action.promo === 'n');
  const buttons = [...document.querySelectorAll('[data-pick]')];
  assert.equal(buttons.length, 4, 'the choice is offered as buttons');

  buttons[main.UI.pendingTargets.indexOf(knight)].onclick();
  assert.equal(eng.state.board['0,7'].p, 'n', 'the chosen promotion was applied');
  assert.equal(main.UI.pendingTargets, null, 'and the prompt cleared');
});

test('main.js contains no game-specific branching', async () => {
  const src = await import('node:fs').then(fs =>
    fs.promises.readFile(new URL('../root/src/main.js', import.meta.url), 'utf8'));
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // The picker legitimately names games via the registry, never in code.
  for (const word of ['armory', 'checkmate', 'jump', 'camp']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(code),
      `main.js branches on "${word}" — the UI should stay generic`);
  }
});

/* ---------- the wordmark: shows the game, and leaves it ---------- */

test('the wordmark names whichever game is loaded', async () => {
  const { main } = await mountUI('chess');
  main.setWordmark(getRuleset('chess').name);
  assert.equal(document.getElementById('gamename').textContent, 'Chess');

  // Switching games must not leave the old name behind.
  main.setWordmark(getRuleset('territory').name);
  assert.equal(document.getElementById('gamename').textContent, 'Territory');
});

test('the wordmark is empty while no game is loaded', async () => {
  const { main } = await mountUI('chess');
  main.setWordmark('Chess');
  main.openPicker();
  assert.equal(document.getElementById('gamename').textContent, '',
    'the picker should not claim a game is still running');
});

test('clicking the wordmark asks before abandoning a live game', async () => {
  const { main, eng } = await mountUI('territory');
  const before = eng.fingerprint();

  main.confirmNew();
  const veil = document.getElementById('veil');
  assert.ok(veil.classList.contains('open'), 'it should prompt, not just quit');
  assert.match(document.getElementById('modal').textContent, /Leave this game/);
  assert.equal(eng.fingerprint(), before, 'and change nothing until answered');

  // Backing out leaves the game exactly as it was.
  document.getElementById('no').onclick();
  assert.ok(!veil.classList.contains('open'));
  assert.equal(eng.fingerprint(), before);
});

test('confirming takes you back to the game list', async () => {
  const { main } = await mountUI('territory');
  main.confirmNew();
  document.getElementById('yes').onclick();

  const modalText = document.getElementById('modal').textContent;
  assert.match(modalText, /Choose a game/, 'the picker is showing');
  assert.equal(document.getElementById('gamename').textContent, '');
});

test('a finished game skips the are-you-sure prompt', async () => {
  const { main } = await mountUI('chess');
  // Fool's mate: the fastest way to a real terminal state.
  const eng = main.UI.engine;
  for (const mv of [
    { type: 'move', x: 5, y: 1, tx: 5, ty: 2 },
    { type: 'move', x: 4, y: 6, tx: 4, ty: 4, double: true },
    { type: 'move', x: 6, y: 1, tx: 6, ty: 3, double: true },
    { type: 'move', x: 3, y: 7, tx: 7, ty: 3 },
  ]) eng.applyAction(mv);
  assert.ok(eng.isOver(), 'the game should be over');

  main.confirmNew();
  assert.match(document.getElementById('modal').textContent, /Choose a game/,
    'nothing is at stake, so go straight to the list');
});

/* ---------- the page shell the UI depends on ---------- */

test('index.html provides the hooks main.js reaches for', async () => {
  const fs = await import('node:fs');
  const html = await fs.promises.readFile(new URL('../root/index.html', import.meta.url), 'utf8');
  for (const id of ['wordmark', 'gamename', 'pbody', 'pfoot', 'veil', 'modal', 'boardwrap']) {
    assert.match(html, new RegExp(`id="${id}"`), `index.html is missing #${id}`);
  }
  assert.match(html, /Checkered/, 'the wordmark should say Checkered');
  assert.doesNotMatch(html, /Boardworks/i, 'the old project name should be gone');
});

test('the board suppresses text selection', async () => {
  const fs = await import('node:fs');
  const css = await fs.promises.readFile(new URL('../root/src/styles.css', import.meta.url), 'utf8');
  // Counters and labels are real text nodes, so dragging to pan would
  // otherwise sweep a selection across every square it crosses.
  assert.match(css, /\.board-view[^}]*user-select:\s*none|user-select:\s*none/,
    'the board must not be selectable');
  const block = css.slice(css.indexOf('.board-view,'), css.indexOf('.board-view,') + 300);
  assert.match(block, /user-select:\s*none/);
  assert.match(block, /-webkit-user-select:\s*none/, 'Safari needs the prefix');
});

test('a seat\u2019s chosen color reaches the piece, not a hardcoded shade', async () => {
  const fs = await import('node:fs');
  const css = await fs.promises.readFile(new URL('../root/src/styles.css', import.meta.url), 'utf8');
  // Rulesets pass seat colors down through describeCell; a fixed color
  // on .piece.light / .piece.dark silently overrides the player's pick.
  assert.match(css, /\.piece\s*\{[^}]*color:\s*var\(--unit-color/,
    '.piece should take its color from the seat');
  const light = css.match(/\.piece\.white,\s*\.piece\.light\s*\{([^}]*)\}/);
  assert.ok(light, 'the light-piece rule should still exist for contrast');
  assert.doesNotMatch(light[1], /(^|[^-])color:\s*#/,
    'it must not hardcode a color over the seat\u2019s own');
});

/* ---------- opening placement ---------- */

test('every player placing an opening piece sees where they may go', async () => {
  const { main, UI } = await mountUI('territory-fresh');
  const eng = UI.engine;

  // Intercept what the board is told to highlight on a normal refresh.
  const marked = () => {
    const m = new Map();
    const orig = UI.board.setHighlights.bind(UI.board);
    UI.board.setHighlights = x => { for (const [k, v] of x) m.set(k, v); return orig(x); };
    main.refresh();
    UI.board.setHighlights = orig;
    return [...m].filter(([, v]) => v === 'place').map(([k]) => k);
  };

  // Player one: a field of squares to choose from.
  UI.selected = null;
  const first = marked();
  assert.ok(first.length > 20, `player one saw ${first.length} placement squares`);

  // Place, then check player two gets their own field rather than an
  // empty board — the bug was that the selection left over from the
  // placement suppressed every highlight.
  const place = main.currentActions().find(a => !a.from);
  main.onCellClick(place.to, {});
  assert.equal(UI.selected, null, 'a placement is not a chain, so nothing stays selected');

  const second = marked();
  assert.ok(second.length > 20, `player two saw only ${second.length} placement squares`);
});

test('the second player cannot place on top of the first', async () => {
  const { main, UI } = await mountUI('territory-fresh');
  const eng = UI.engine;

  const place = main.currentActions().find(a => !a.from);
  main.onCellClick(place.to, {});
  const taken = place.to;

  // The spacing rule should remove the neighbourhood of the first camp
  // from what the second player is offered.
  const offered = main.currentActions().filter(a => !a.from).map(a => `${a.to.x},${a.to.y}`);
  const spacing = eng.config.campSpacing;
  for (const k of offered) {
    const [x, y] = k.split(',').map(Number);
    const gap = Math.max(Math.abs(x - taken.x), Math.abs(y - taken.y));
    assert.ok(gap >= spacing,
      `${k} is only ${gap} from the first camp, closer than the ${spacing} required`);
  }
  assert.ok(offered.length > 0, 'and there should still be somewhere to go');
});

test('filled buttons stay readable on hover', async () => {
  const fs = await import('node:fs');
  const css = await fs.promises.readFile(new URL('../root/src/styles.css', import.meta.url), 'utf8');
  // The generic hover paints text brass; on a brass-filled button that
  // erases the label, so filled buttons need their own hover rule.
  const rule = css.match(/button\.on:hover[^{]*,\s*\n?button\.primary:hover[^{]*\{([^}]*)\}/);
  assert.ok(rule, 'filled buttons need a hover rule of their own');
  assert.match(rule[1], /color:\s*var\(--ink\)/, 'the label must stay dark');
  // Darkening read as "disabled"; a filled button should look more
  // alive on hover, not less.
  assert.match(rule[1], /background:\s*var\(--brass-bright\)/,
    'the fill should brighten, not darken');
});

test('placement squares are marked apart from move targets', async () => {
  const { main, UI } = await mountUI('territory-fresh');
  const marks = new Map();
  UI.board.setHighlights = x => { for (const [k, v] of x) marks.set(k, v); };
  main.refresh();

  const kinds = new Set(marks.values());
  assert.ok(kinds.has('place'), 'an opening field should use its own mark');
  assert.ok(!kinds.has('target'),
    'placement must not borrow the move-target treatment \u2014 it covers the whole view');

  const fs = await import('node:fs');
  const css = await fs.promises.readFile(new URL('../root/src/styles.css', import.meta.url), 'utf8');
  const place = css.match(/\.cell\.hl-place\s*\{([^}]*)\}/);
  assert.ok(place, 'hl-place needs a style of its own');
  assert.doesNotMatch(place[1], /dashed/, 'the quiet treatment should not be dashed');
});

test('every built-in ruleset knows where its own source lives', async () => {
  const { allRulesets } = await import('../root/rulesets/index.js');
  for (const e of allRulesets()) {
    assert.ok(e.sourceUrl || e.source,
      `${e.id} has no source for the code editor to show`);
  }
});

test('a ruleset registered from pasted text carries its own text', async () => {
  const { registerRuleset, getRuleset, unregisterRuleset } = await import('../root/rulesets/index.js');
  const { default: chess } = await import('../root/rulesets/chess.js');
  const variant = { ...chess, id: 'chess-variant', name: 'Chess Variant' };
  const entry = registerRuleset(variant, { source: '// pasted', custom: true });
  assert.equal(entry.source, '// pasted', 'the editor should show what was pasted');
  assert.equal(getRuleset('chess-variant').source, '// pasted');
  unregisterRuleset('chess-variant');
});

/* ---------- playing someone else ---------- */

test('undo is refused while a match is running', async () => {
  // Undo is local. In a shared game it would put the two sides on
  // different boards, and every move afterwards would be reported as a
  // disagreement with no sign of the real cause.
  const { main, UI } = await mountUI('chess');
  const { hostMatch } = await import('../root/src/match.js');
  const { getRuleset } = await import('../root/rulesets/index.js');

  const entry = getRuleset('chess');
  const { match } = hostMatch({ entry, players: entry.defaultPlayers, seed: 5 });
  UI.match = match;
  UI.engine = match.engine;
  UI.online = true;

  match.act(match.engine.legalActions(0)[0]);
  main.refresh();

  const undo = document.getElementById('undo');
  assert.ok(undo.hasAttribute('disabled'), 'the undo button should be disabled in a match');
  assert.equal(document.querySelectorAll('#log .undoable').length, 0,
    'and the record should not offer to rewind either');

  UI.match = null;
  UI.online = false;
});

test('the board is not clickable on the other player\u2019s turn', async () => {
  const { main, UI } = await mountUI('chess');
  const { hostMatch } = await import('../root/src/match.js');
  const { getRuleset } = await import('../root/rulesets/index.js');

  const entry = getRuleset('chess');
  const { match } = hostMatch({ entry, players: entry.defaultPlayers, seed: 5 });
  UI.match = match;
  UI.engine = match.engine;

  match.act(match.engine.legalActions(0)[0]);        // now it is seat 1's turn
  assert.equal(match.canAct(), false);

  const before = match.engine.history.length;
  const theirs = main.currentActions().find(a => a.from && a.to);
  if (theirs) {
    main.onCellClick(theirs.from, {});
    main.onCellClick(theirs.to, {});
  }
  assert.equal(match.engine.history.length, before,
    'clicking during their turn must not move their pieces');

  UI.match = null;
});

/* ---------- keeping the game ---------- */

test('the game in progress is written down as it is played', async () => {
  const { main, UI } = await mountUI('chess');
  const { hasResumable, loadAutosave, clearAutosave } = await import('../root/src/saves.js');
  clearAutosave();

  const step = main.currentActions().find(a => a.from && a.to);
  main.onCellClick(step.from, {});
  main.onCellClick(step.to, {});

  // The write is debounced, so a Territory turn of a hundred actions
  // doesn't write a hundred times. Wait for it to land.
  await new Promise(r => setTimeout(r, 400));

  assert.ok(hasResumable(), 'a played move should leave something to come back to');
  const save = loadAutosave();
  assert.equal(save.rulesetId, 'chess');
  assert.ok(save.actions.length >= 1);
  assert.equal(save.board, undefined, 'a save is actions, not a board');
  clearAutosave();
});

test('a restored game lands on the same position', async () => {
  const { main, UI } = await mountUI('chess');
  const { snapshot, restore } = await import('../root/src/saves.js');

  for (const a of main.currentActions().slice(0, 1)) {
    UI.engine.applyAction(a.action, a.actor);
  }
  const before = UI.engine.fingerprint();
  const { engine } = restore(snapshot(UI.engine, { entry: UI.entry }));
  assert.equal(engine.fingerprint(), before);
});

/* ---------- knowing which step you are in ---------- */

test('the board is told which step the game is in', async () => {
  // Playtesting found people producing, then clicking again expecting to
  // produce and moving a piece instead, because the step had changed
  // quietly. main.js passes the ruleset's own word for the phase to the
  // board as data; the stylesheet colours the ground by it.
  const { main, UI } = await mountUI('territory');
  main.refresh();

  const phase = UI.board.mount.dataset.phase;
  assert.ok(phase, 'the board should carry the current phase');
  assert.equal(phase, UI.engine.ruleset.summarize(UI.engine.state).phase,
    'and it should be the phase the ruleset reports');
});

test('the phase on the board follows the game', async () => {
  const { main, UI } = await mountUI('territory');
  main.refresh();
  const before = UI.board.mount.dataset.phase;

  // Produce until the step ends, then check the board noticed.
  for (let i = 0; i < 60; i++) {
    const done = main.currentActions().find(a => a.action.type === 'endProduction');
    if (done) { UI.engine.applyAction(done.action, done.actor); break; }
    const any = main.currentActions()[0];
    if (!any) break;
    UI.engine.applyAction(any.action, any.actor);
  }
  main.refresh();
  assert.notEqual(UI.board.mount.dataset.phase, before,
    'the board should show the step changing');
});

test('a game with no phases leaves the board unmarked', async () => {
  // Not every ruleset has steps; the board must not invent one.
  const { main, UI } = await mountUI('chess');
  main.refresh();
  const phase = UI.board.mount.dataset.phase;
  const reported = UI.engine.ruleset.summarize(UI.engine.state).phase;
  assert.equal(phase, reported ? String(reported) : undefined);
});

test('index.html carries somewhere to announce the step', async () => {
  const fs = await import('node:fs');
  const html = await fs.promises.readFile(new URL('../root/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="phase-banner"/);
  assert.match(html, /aria-live/, 'the announcement should reach a screen reader too');
});
