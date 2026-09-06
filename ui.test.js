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

import { Engine } from '../src/engine.js';
import { allRulesets, getRuleset } from '../rulesets/index.js';

function setupDom() {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="app"><div id="boardwrap"><button id="zin"></button>
    <button id="zout"></button><button id="zhome"></button></div>
    <aside id="panel"><div id="pbody"></div><div id="pfoot"></div></aside></div>
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
  const entry = getRuleset(id);
  const eng = new Engine(entry.ruleset, {
    players: entry.defaultPlayers.slice(0, Math.max(2, entry.minPlayers)),
    config: id === 'territory' ? { scatterStacks: 1 } : {},
    seed: 3,
  });
  for (const { action, actorId } of OPENINGS[id] || []) eng.applyAction(action, actorId);
  return { eng, entry };
}

/** Boot main.js against a live engine, bypassing the picker. */
async function mountUI(id) {
  setupDom();
  const main = await import('../src/main.js?ui=' + id);
  const { UI } = main;
  const { BoardView } = await import('../src/board.js');
  const { eng, entry } = gameFor(id);

  UI.engine = eng;
  UI.entry = entry;
  UI.selected = null;
  UI.pendingTargets = null;
  UI.lastMove = null;
  UI.board = new BoardView(document.getElementById('boardwrap'), {
    onCellClick: main.onCellClick,
  });
  UI.board.attach(eng);
  return { main, UI, eng };
}

for (const entry of allRulesets()) {
  test(`${entry.name}: selecting a piece reveals targets, clicking one acts`, async () => {
    const { main, UI, eng } = await mountUI(entry.id);
    const actions = main.currentActions();

    // Find an action that actually moves between two distinct squares.
    const step = actions.find(a => a.from && a.to &&
      !(a.from.x === a.to.x && a.from.y === a.to.y));
    assert.ok(step, `${entry.name} offered no square-to-square action`);

    const before = eng.fingerprint();
    const actionCount = eng.history.length;

    main.onCellClick(step.from, {});
    assert.deepEqual(UI.selected, step.from, 'the click selected the origin');

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
    const step = main.currentActions().find(a => a.from && a.to);
    const before = eng.fingerprint();
    const acted = eng.history.length;   // openings already count as actions

    main.onCellClick(step.from, { inspect: true });
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
  const main = await import('../src/main.js?promo');
  const { BoardView } = await import('../src/board.js');
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
    fs.promises.readFile(new URL('../src/main.js', import.meta.url), 'utf8'));
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  // The picker legitimately names games via the registry, never in code.
  for (const word of ['armory', 'checkmate', 'jump', 'camp']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(code),
      `main.js branches on "${word}" — the UI should stay generic`);
  }
});
