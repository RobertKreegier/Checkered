/* board.js — the board, as real DOM.
 *
 * Deliberately not canvas. Every cell and every piece is an element with
 * classes on it, so a player's own CSS can restyle the whole board
 * without this file knowing anything about it. That is the entire reason
 * for the DOM/SVG choice: canvas pixels can't be themed with a
 * stylesheet, and per-player theming is a first-class goal.
 *
 * Virtualized: only cells inside the viewport are mounted, and elements
 * are pooled between frames, so an infinite board costs the same as a
 * small one. Territory pans forever; chess and checkers report finite
 * bounds and get fitted to the view instead.
 *
 * This file knows nothing about any game. Everything it draws comes from
 * the ruleset's describeCell(), as plain data.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class BoardView {
  /**
   * @param mount   element to fill
   * @param options {cell, minZoom, maxZoom, onCellClick, onCellHover}
   */
  constructor(mount, options = {}) {
    this.mount = mount;
    this.cell = options.cell ?? 64;
    this.minZoom = options.minZoom ?? 0.35;
    this.maxZoom = options.maxZoom ?? 2.4;
    this.onCellClick = options.onCellClick || (() => {});
    this.onCellHover = options.onCellHover || (() => {});

    this.cam = { x: 0, y: 0, z: 1 };
    this.engine = null;
    this.ruleset = null;
    this.highlights = new Map();   // "x,y" -> class name
    this.selected = null;
    this.pool = [];                // recycled cell elements
    this.live = new Map();         // "x,y" -> element in use
    this.frame = null;

    this.build();
    this.bindInput();

    this.ro = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => this.draw())
      : null;
    if (this.ro) this.ro.observe(mount);
  }

  build() {
    this.mount.classList.add('board-view');
    this.root = document.createElement('div');
    this.root.className = 'board-root';
    this.layer = document.createElement('div');
    this.layer.className = 'board-layer';
    this.root.appendChild(this.layer);
    this.mount.appendChild(this.root);
  }

  /* ---------- camera ---------- */

  get scale() {
    return this.cell * this.cam.z;
  }

  panBy(dx, dy) {
    // Board y grows upward, screen y grows downward, so the vertical
    // term is added where the horizontal one is subtracted. Dragging
    // down must bring the ground down with the cursor.
    this.cam.x -= dx / this.scale;
    this.cam.y += dy / this.scale;
    this.constrain();
    this.draw();
  }

  panTo(x, y) {
    this.cam.x = x;
    this.cam.y = y;
    this.constrain();
    this.draw();
  }

  zoomAt(factor, px, py) {
    const before = this.pointToCell(px, py, true);
    this.cam.z = clamp(this.cam.z * factor, this.minZoom, this.maxZoom);
    const after = this.pointToCell(px, py, true);
    this.cam.x += before.x - after.x;
    this.cam.y += before.y - after.y;
    this.constrain();
    this.draw();
  }

  /** Keep a finite board from being scrolled off into empty space. */
  constrain() {
    const b = this.bounds();
    if (!b) return;
    const pad = 1.5;
    this.cam.x = clamp(this.cam.x, b.x0 - pad, b.x1 + 1 + pad);
    this.cam.y = clamp(this.cam.y, b.y0 - pad, b.y1 + 1 + pad);
  }

  bounds() {
    if (!this.ruleset || typeof this.ruleset.bounds !== 'function') return null;
    return this.ruleset.bounds(this.engine.state) || null;
  }

  /** Fit a finite board to the viewport, centred. */
  fit() {
    const b = this.bounds();
    const r = this.mount.getBoundingClientRect();
    if (!b || !r.width) return;
    const cols = b.x1 - b.x0 + 1, rows = b.y1 - b.y0 + 1;
    const z = Math.min(r.width / (cols * this.cell), r.height / (rows * this.cell)) * 0.92;
    this.cam.z = clamp(z, this.minZoom, this.maxZoom);
    this.cam.x = b.x0 + cols / 2;
    this.cam.y = b.y0 + rows / 2;
    this.draw();
  }

  /* ---------- coordinates ---------- */

  /** Screen point -> board coordinate. `exact` keeps the fraction. */
  pointToCell(px, py, exact = false) {
    const r = this.mount.getBoundingClientRect();
    const x = (px - r.width / 2) / this.scale + this.cam.x;
    const y = this.cam.y - (py - r.height / 2) / this.scale;
    return exact ? { x, y } : { x: Math.floor(x), y: Math.floor(y) };
  }

  /** Board coordinate -> pixel offset of that cell's top-left corner. */
  cellToPoint(x, y) {
    const r = this.mount.getBoundingClientRect();
    return {
      left: (x - this.cam.x) * this.scale + r.width / 2,
      // y grows upward on the board, downward on screen.
      top: (this.cam.y - y - 1) * this.scale + r.height / 2,
    };
  }

  /* ---------- input ---------- */

  bindInput() {
    let drag = null, moved = false;

    this.root.addEventListener('pointerdown', e => {
      this.root.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
      moved = false;
    });

    this.root.addEventListener('pointermove', e => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          moved = true;
          this.panBy(dx, dy);
          drag = { x: e.clientX, y: e.clientY };
        }
      }
      const r = this.mount.getBoundingClientRect();
      const c = this.pointToCell(e.clientX - r.left, e.clientY - r.top);
      if (!this.hover || this.hover.x !== c.x || this.hover.y !== c.y) {
        this.hover = c;
        this.onCellHover(c);
        this.draw();
      }
    });

    this.root.addEventListener('pointerup', e => {
      const wasDrag = moved;
      drag = null;
      if (wasDrag) return;
      const r = this.mount.getBoundingClientRect();
      const c = this.pointToCell(e.clientX - r.left, e.clientY - r.top);
      // Shift, right-click, and ctrl always mean "inspect, don't act".
      this.onCellClick(c, { inspect: e.shiftKey || e.button === 2 || e.ctrlKey });
    });

    this.root.addEventListener('pointerleave', () => {
      drag = null;
      this.hover = null;
      this.draw();
    });

    this.root.addEventListener('contextmenu', e => {
      e.preventDefault();
      const r = this.mount.getBoundingClientRect();
      const c = this.pointToCell(e.clientX - r.left, e.clientY - r.top);
      this.onCellClick(c, { inspect: true });
    });

    this.root.addEventListener('wheel', e => {
      e.preventDefault();
      const r = this.mount.getBoundingClientRect();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
      const factor = clamp(Math.exp(-px * 0.0016), 1 / 1.06, 1.06);
      this.zoomAt(factor, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
  }

  /* ---------- what to show ---------- */

  attach(engine) {
    this.engine = engine;
    this.ruleset = engine.ruleset;
    if (this.bounds()) this.fit();
    else this.draw();
  }

  /** Mark squares — legal targets, last move, whatever the UI wants. */
  setHighlights(map) {
    this.highlights = map instanceof Map ? map : new Map(Object.entries(map || {}));
    this.draw();
  }

  setSelected(cell) {
    this.selected = cell ? { ...cell } : null;
    this.draw();
  }

  /* ---------- drawing ---------- */

  /** Coalesce redraws into one per animation frame. */
  draw() {
    if (this.frame) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : fn => setTimeout(fn, 16);
    this.frame = schedule(() => {
      this.frame = null;
      this.render();
    });
  }

  /** Which cells are visible right now. */
  visibleRange() {
    const r = this.mount.getBoundingClientRect();
    const halfW = r.width / (2 * this.scale), halfH = r.height / (2 * this.scale);
    let x0 = Math.floor(this.cam.x - halfW) - 1;
    let x1 = Math.ceil(this.cam.x + halfW) + 1;
    let y0 = Math.floor(this.cam.y - halfH) - 1;
    let y1 = Math.ceil(this.cam.y + halfH) + 1;
    const b = this.bounds();
    if (b) {
      x0 = Math.max(x0, b.x0); x1 = Math.min(x1, b.x1);
      y0 = Math.max(y0, b.y0); y1 = Math.min(y1, b.y1);
    }
    return { x0, x1, y0, y1 };
  }

  render() {
    if (!this.engine) return;
    const { x0, x1, y0, y1 } = this.visibleRange();
    const size = this.scale;
    const wanted = new Set();

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = x + ',' + y;
        wanted.add(key);
        const el = this.live.get(key) || this.take(key);
        this.paint(el, x, y, size);
      }
    }

    // Retire cells that scrolled out of view.
    for (const [key, el] of this.live) {
      if (wanted.has(key)) continue;
      this.live.delete(key);
      el.remove();
      if (this.pool.length < 400) this.pool.push(el);
    }
  }

  take(key) {
    const el = this.pool.pop() || this.makeCell();
    this.live.set(key, el);
    this.layer.appendChild(el);
    return el;
  }

  makeCell() {
    const el = document.createElement('div');
    el.className = 'cell';
    el.innerHTML = '<div class="piece-slot"></div><div class="cell-tags"></div>';
    return el;
  }

  paint(el, x, y, size) {
    const { left, top } = this.cellToPoint(x, y);
    el.style.width = el.style.height = size + 'px';
    el.style.transform = `translate(${left}px, ${top}px)`;
    el.style.fontSize = Math.max(9, size * 0.17) + 'px';

    const key = x + ',' + y;
    const dark = ((x + y) & 1) === 0;
    const view = this.ruleset.describeCell(this.engine.state, x, y);
    const highlight = this.highlights.get(key);
    const isSel = this.selected && this.selected.x === x && this.selected.y === y;
    const isHover = this.hover && this.hover.x === x && this.hover.y === y;

    el.className = [
      'cell', dark ? 'dark' : 'light',
      view ? 'occupied' : 'empty',
      highlight ? 'hl-' + highlight : '',
      isSel ? 'selected' : '',
      isHover ? 'hovered' : '',
    ].filter(Boolean).join(' ');
    el.dataset.x = x;
    el.dataset.y = y;

    const slot = el.firstChild;
    const tags = el.lastChild;

    if (!view) {
      // Cells are pooled and reused, so an emptied one has to be wiped
      // completely. Leaving any of these behind lets the last occupant
      // bleed through: a stale `label` shows a caption on bare ground,
      // and a stale `sig` convinces the next occupant it is already
      // drawn, so its piece never appears.
      if (slot.childNodes.length) slot.textContent = '';
      if (tags.childNodes.length) tags.textContent = '';
      delete slot.dataset.sig;
      delete tags.dataset.html;
      delete el.dataset.label;
      for (const name of el.dataset.vars ? el.dataset.vars.split(' ') : []) {
        el.style.removeProperty(name);
      }
      delete el.dataset.vars;
      return;
    }

    // Colors arrive as a named bag and become CSS custom properties, so
    // a stylesheet can use them without this file knowing what they mean.
    const vars = [];
    for (const [name, value] of Object.entries(view.colors || {})) {
      const prop = '--' + name;
      el.style.setProperty(prop, value);
      vars.push(prop);
    }
    el.dataset.vars = vars.join(' ');

    // A piece is described as data; how it looks is the stylesheet's call.
    const cls = ['piece'].concat(view.classes || []).join(' ');
    const glyph = view.glyph || '';
    const stack = view.stackHeight || 1;
    const signature = `${cls}|${glyph}|${stack}|${view.ownerId}`;
    if (slot.dataset.sig !== signature) {
      slot.dataset.sig = signature;
      slot.innerHTML = '';
      const piece = document.createElement('div');
      piece.className = cls;
      if (view.ownerId !== null && view.ownerId !== undefined) {
        piece.dataset.owner = view.ownerId;
      }
      if (glyph) piece.textContent = glyph;
      if (stack > 1) piece.style.setProperty('--stack', stack);
      slot.appendChild(piece);
    }

    // Counters are an ordered list of {kind, value} the ruleset supplies;
    // `kind` becomes a class so the stylesheet can place and color them.
    const html = size >= 40
      ? (view.counters || [])
        .filter(c => c && c.value)
        .map(c => `<span class="tag ${c.kind || 'count'}">${c.value}</span>`)
        .join('')
      : '';
    if (tags.dataset.html !== html) {
      tags.dataset.html = html;
      tags.innerHTML = html;
    }

    if (size >= 62 && view.label) {
      el.dataset.label = view.label;
    } else {
      delete el.dataset.label;
    }
  }

  destroy() {
    if (this.ro) this.ro.disconnect();
    this.layer.innerHTML = '';
    this.live.clear();
    this.pool.length = 0;
  }
}

export default BoardView;
