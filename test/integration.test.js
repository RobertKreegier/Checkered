/* integration.test.js — the renderer, driven headlessly under jsdom.
 *
 * board.js is the one module allowed to touch the DOM, so it is the one
 * module that needs a DOM to test. Everything asserted here is about the
 * renderer staying generic: it must draw any registered game without
 * knowing which one it is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { Engine } from '../src/engine.js';
import { allRulesets, getRuleset } from '../rulesets/index.js';

/** A fresh jsdom, with globals set up the way a browser would have them. */
function withDom(width = 800, height = 600) {
  const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  global.window = window;
  global.document = window.document;
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 0);

  const mount = window.document.getElementById('mount');
  // jsdom gives everything zero size, so the viewport has to be faked.
  mount.getBoundingClientRect = () => ({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
  });
  return { dom, window, mount };
}

/** Render synchronously rather than waiting on animation frames. */
function paint(view) {
  view.render();
}

async function loadBoard() {
  const mod = await import('../src/board.js');
  return mod.BoardView;
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
    config: id === 'territory' ? { scatterStacks: 2 } : {},
    seed: 7,
  });
  for (const { action, actorId } of OPENINGS[id] || []) eng.applyAction(action, actorId);
  return eng;
}

test('the board mounts and renders cells for every ruleset', async () => {
  const BoardView = await loadBoard();
  for (const entry of allRulesets()) {
    const { mount } = withDom();
    const view = new BoardView(mount);
    view.attach(gameFor(entry.id));
    paint(view);
    const cells = mount.querySelectorAll('.cell');
    assert.ok(cells.length > 0, `${entry.name} rendered no cells`);
    view.destroy();
  }
});

test('pieces are real elements carrying the ruleset\u2019s classes', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const view = new BoardView(mount);
  view.attach(gameFor('chess'));
  paint(view);

  const pieces = mount.querySelectorAll('.piece');
  assert.equal(pieces.length, 32, 'a chess board opens with 32 pieces');
  const white = mount.querySelectorAll('.piece.white');
  assert.equal(white.length, 16);
  assert.ok(mount.querySelector('.piece.king'), 'a king is drawn with its own class');
});

test('only visible cells are mounted on an infinite board', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom(800, 600);
  const view = new BoardView(mount);
  view.attach(gameFor('territory'));
  paint(view);

  const near = mount.querySelectorAll('.cell').length;
  // 800x600 at 64px cells is on the order of a couple of hundred cells,
  // not the whole infinite plane.
  assert.ok(near > 0 && near < 500, `expected a viewport-sized batch, got ${near}`);

  // Pan a long way; the count should stay in the same ballpark.
  view.panTo(5000, 5000);
  paint(view);
  const far = mount.querySelectorAll('.cell').length;
  assert.ok(far < 500, `panning blew up the cell count: ${far}`);
});

test('elements are recycled rather than piling up', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const view = new BoardView(mount);
  view.attach(gameFor('territory'));
  paint(view);
  const first = mount.querySelectorAll('.cell').length;

  for (let i = 0; i < 20; i++) {
    view.panTo(i * 3, i * 3);
    paint(view);
  }
  const after = mount.querySelectorAll('.cell').length;
  assert.ok(Math.abs(after - first) < 120, `cell count drifted from ${first} to ${after}`);
  assert.ok(view.pool.length > 0, 'retired cells should be pooled for reuse');
});

test('a finite board is fitted and cannot be panned into nothing', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const view = new BoardView(mount);
  view.attach(gameFor('checkers'));
  paint(view);

  // attach() fits a bounded board, so the camera lands on its middle.
  assert.ok(view.cam.x > 2 && view.cam.x < 6, `camera off-centre at ${view.cam.x}`);
  view.panTo(9999, 9999);
  assert.ok(view.cam.x < 12 && view.cam.y < 12, 'the camera is held near the board');
});

test('clicking a cell reports its board coordinate', async () => {
  const BoardView = await loadBoard();
  const { window, mount } = withDom();
  const seen = [];
  const view = new BoardView(mount, { onCellClick: (c, opts) => seen.push({ c, opts }) });
  view.attach(gameFor('chess'));
  paint(view);

  const target = view.cellToPoint(4, 0);
  const size = view.scale;
  const ev = new window.MouseEvent('pointerup', {
    clientX: target.left + size / 2,
    clientY: target.top + size / 2,
    bubbles: true,
  });
  view.root.dispatchEvent(ev);

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].c, { x: 4, y: 0 }, 'the click maps back to the square drawn there');
});

test('shift-click and right-click are reported as inspect', async () => {
  const BoardView = await loadBoard();
  const { window, mount } = withDom();
  const seen = [];
  const view = new BoardView(mount, { onCellClick: (c, opts) => seen.push(opts) });
  view.attach(gameFor('chess'));
  paint(view);

  const p = view.cellToPoint(0, 0);
  view.root.dispatchEvent(new window.MouseEvent('pointerup', {
    clientX: p.left + 5, clientY: p.top + 5, shiftKey: true, bubbles: true,
  }));
  assert.equal(seen[0].inspect, true);
});

test('highlights and selection show up as classes, not baked-in styling', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const view = new BoardView(mount);
  view.attach(gameFor('chess'));
  view.setHighlights({ '4,3': 'target', '4,2': 'target' });
  view.setSelected({ x: 4, y: 1 });
  paint(view);

  assert.equal(mount.querySelectorAll('.hl-target').length, 2);
  assert.equal(mount.querySelectorAll('.selected').length, 1);
  const sel = mount.querySelector('.selected');
  assert.equal(sel.dataset.x, '4');
  assert.equal(sel.dataset.y, '1');
});

test('the board follows the engine as the game changes', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const eng = gameFor('chess');
  const view = new BoardView(mount);
  view.attach(eng);
  paint(view);

  const before = mount.querySelectorAll('.piece').length;
  eng.applyAction({ type: 'move', x: 4, y: 1, tx: 4, ty: 3, double: true });
  paint(view);

  assert.equal(mount.querySelectorAll('.piece').length, before, 'nothing was captured');
  const from = [...mount.querySelectorAll('.cell')].find(c => c.dataset.x === '4' && c.dataset.y === '1');
  const to = [...mount.querySelectorAll('.cell')].find(c => c.dataset.x === '4' && c.dataset.y === '3');
  assert.ok(!from.querySelector('.piece'), 'the pawn left its square');
  assert.ok(to.querySelector('.piece'), 'and arrived at the new one');
});

test('zooming keeps the point under the cursor put', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const view = new BoardView(mount);
  view.attach(gameFor('territory'));
  paint(view);

  const px = 300, py = 200;
  const before = view.pointToCell(px, py, true);
  view.zoomAt(1.5, px, py);
  const after = view.pointToCell(px, py, true);
  assert.ok(Math.abs(before.x - after.x) < 0.001, 'x drifted while zooming');
  assert.ok(Math.abs(before.y - after.y) < 0.001, 'y drifted while zooming');
});

test('the renderer holds no game-specific knowledge', async () => {
  const src = await import('node:fs').then(fs =>
    fs.promises.readFile(new URL('../src/board.js', import.meta.url), 'utf8'));
  // Strip both block and line comments before looking: prose about the
  // design is fine, code that knows the game is not.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const word of ['territory', 'chess', 'checkers', 'armory', 'camp', 'pawn', 'knight', 'king']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(code),
      `board.js mentions "${word}" in code — the layers have leaked`);
  }
});

test('dragging moves the board with the cursor, both axes', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const view = new BoardView(mount);
  view.attach(gameFor('territory'));
  view.panTo(0, 0);
  paint(view);

  // Where a fixed square sits on screen before and after a drag: it
  // should travel the same direction and distance as the cursor.
  const before = view.cellToPoint(0, 0);
  view.panBy(40, 60);          // cursor moves right and down
  const after = view.cellToPoint(0, 0);

  assert.ok(Math.abs((after.left - before.left) - 40) < 0.001,
    'the board should follow the cursor horizontally');
  assert.ok(Math.abs((after.top - before.top) - 60) < 0.001,
    'and vertically \u2014 dragging down must not send the board up');
});

test('a recycled cell keeps nothing from its last occupant', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const eng = gameFor('chess');
  const view = new BoardView(mount);
  view.attach(eng);
  paint(view);

  const cellAt = (x, y) => [...mount.querySelectorAll('.cell')]
    .find(c => c.dataset.x === String(x) && c.dataset.y === String(y));

  const from = cellAt(4, 1);
  assert.ok(from.dataset.label, 'the pawn square starts with a caption');

  eng.applyAction({ type: 'move', x: 4, y: 1, tx: 4, ty: 3, double: true });
  paint(view);

  const emptied = cellAt(4, 1);
  assert.equal(emptied.dataset.label, undefined,
    'a vacated square must not keep the caption of what stood there');
  assert.ok(!emptied.querySelector('.piece'), 'and no piece');
  assert.equal(emptied.firstChild.dataset.sig, undefined,
    'a stale signature would stop the next piece from being drawn');
});

test('a square emptied then reoccupied draws the new piece', async () => {
  // The failure this guards against is subtle: if `sig` survives being
  // emptied, an identical piece arriving later is considered already
  // drawn and never appears.
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const eng = gameFor('chess');
  const view = new BoardView(mount);
  view.attach(eng);
  paint(view);

  const cellAt = (x, y) => [...mount.querySelectorAll('.cell')]
    .find(c => c.dataset.x === String(x) && c.dataset.y === String(y));

  eng.applyAction({ type: 'move', x: 1, y: 0, tx: 2, ty: 2 });   // knight out
  paint(view);
  assert.ok(!cellAt(1, 0).querySelector('.piece'));

  eng.applyAction({ type: 'move', x: 1, y: 6, tx: 1, ty: 5 });
  eng.applyAction({ type: 'move', x: 2, y: 2, tx: 1, ty: 0 });   // and back
  paint(view);
  assert.ok(cellAt(1, 0).querySelector('.piece'),
    'the returning knight must be drawn again');
});

test('a counted piece is drawn as a column, one chip per unit', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const eng = gameFor('territory');
  const view = new BoardView(mount);
  view.attach(eng);
  paint(view);

  const columned = mount.querySelectorAll('.piece.columned');
  assert.ok(columned.length > 0, 'a stack should be drawn as a column');

  // Each chip element corresponds to something counted, and the kinds
  // become classes so a stylesheet can tell them apart.
  const chips = mount.querySelectorAll('.chip');
  assert.ok(chips.length > 0, 'no chips were drawn');
  assert.ok(mount.querySelector('.chip.units'), 'unit chips carry their kind');
});

test('a tall column is elided rather than growing off the square', async () => {
  const BoardView = await loadBoard();
  const { mount } = withDom();
  const eng = gameFor('territory');
  const view = new BoardView(mount);
  view.attach(eng);
  paint(view);

  // The opening camp is eight chips, above the drawing cap.
  const camp = [...mount.querySelectorAll('.piece.columned')]
    .find(p => p.querySelectorAll('.chip').length);
  assert.ok(camp);
  assert.ok(camp.querySelectorAll('.chip').length <= 9,
    'the column should be capped, not drawn one-for-one forever');
  assert.ok(mount.querySelector('.chip.elided'),
    'and the break should be marked so the height is not read as exact');
});

test('chess and checkers still draw a glyph, not a column', async () => {
  const BoardView = await loadBoard();
  for (const id of ['chess', 'checkers']) {
    const { mount } = withDom();
    const view = new BoardView(mount);
    view.attach(gameFor(id));
    paint(view);
    assert.equal(mount.querySelectorAll('.chip').length, 0,
      `${id} has nothing to count, so it should not be columned`);
    assert.ok(mount.querySelector('.piece').textContent.length > 0,
      `${id} pieces should still show their glyph`);
  }
});
