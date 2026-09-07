/* main.js — wiring the engine, the board, and the panel together.
 *
 * The interesting constraint: this file must work for any registered
 * ruleset without knowing which one it is. It never asks "is this
 * chess?" — it asks the ruleset what actions exist, where they point
 * (describeAction), and what to draw (describeCell), then offers them.
 *
 * The interaction model that falls out is the same for all three games:
 *   click a piece    -> select it, highlight where its actions land
 *   click a target   -> if one action goes there, do it; if several
 *                       (a promotion, a chip split), ask which
 * Actions with no target square (end turn, trade armory) become buttons.
 */

import { Engine } from './engine.js';
import { BoardView } from './board.js';
import { allRulesets, getRuleset, registerRuleset } from '../rulesets/index.js';
import { seedFromString } from './rng.js';
import { applyTheme, loadTheme, saveTheme, resetTheme, THEME_KEY } from './theme.js';

const $ = sel => document.querySelector(sel);

/**
 * The wordmark carries the loaded game's name: "Checkered Territory".
 * It reads from the registry entry rather than from anything the engine
 * knows, so the UI still learns nothing about the game itself.
 */
function setWordmark(name) {
  const el = $('#gamename');
  if (el) el.textContent = name || '';
}

const UI = {
  engine: null,
  entry: null,
  board: null,
  selected: null,
  pendingTargets: null,   // actions competing for the same square
  lastMove: null,
};

/* ============================================================
   SETUP
   ============================================================ */

function openPicker() {
  setWordmark('');
  const games = allRulesets();
  let chosen = games[0];
  let count = Math.max(2, chosen.minPlayers);

  const paint = () => {
    const seats = Array.from({ length: count }, (_, i) => {
      const d = chosen.defaultPlayers[i]
        || { name: 'Player ' + (i + 1), colors: { primary: '#888888', accent: '#cccccc' } };
      return `<div class="prow">
        <span class="idx">${i + 1}</span>
        <input type="text" id="nm${i}" value="${d.name}" maxlength="14">
        <input type="color" id="uc${i}" value="${d.colors?.primary || '#888888'}" title="main color">
        <input type="color" id="ac${i}" value="${d.colors?.accent || '#cccccc'}" title="accent color">
      </div>`;
    }).join('');

    const range = [];
    for (let n = chosen.minPlayers; n <= chosen.maxPlayers; n++) range.push(n);

    modal(`
      <h2>Check<span>ered</span></h2>
      <p class="sub">One engine · any game that fits a grid</p>
      <div class="eyebrow">Choose a game</div>
      ${games.map(g => `
        <div class="gamecard ${g.id === chosen.id ? 'on' : ''}" data-game="${g.id}">
          <div>
            <div class="gname">${g.name}</div>
            <div class="gblurb">${g.blurb}</div>
          </div>
        </div>`).join('')}
      <div class="eyebrow" style="margin-top:18px">Players</div>
      <div class="btnrow" style="margin-bottom:14px">
        ${range.map(n => `<button class="${n === count ? 'on' : ''}" data-n="${n}">${n === 1 ? 'Solo' : n + ' players'}</button>`).join('')}
      </div>
      ${seats}
      <div class="warn" id="warn"></div>
      <div class="btnrow" style="margin-top:12px">
        <button class="primary" id="go">Set the board</button>
        <button id="rules">Read the rules</button>
      </div>`);

    modal.el.querySelectorAll('[data-game]').forEach(el => {
      el.onclick = () => {
        chosen = getRuleset(el.dataset.game);
        count = Math.min(Math.max(count, chosen.minPlayers), chosen.maxPlayers);
        paint();
      };
    });
    modal.el.querySelectorAll('[data-n]').forEach(b => {
      b.onclick = () => { count = +b.dataset.n; paint(); };
    });
    $('#rules').onclick = () => showRules(chosen.ruleset, paint);
    $('#go').onclick = () => {
      const players = [];
      for (let i = 0; i < count; i++) {
        players.push({
          name: ($('#nm' + i).value || 'Player ' + (i + 1)).trim(),
          colors: { primary: $('#uc' + i).value, accent: $('#ac' + i).value },
        });
      }
      const colors = players.flatMap(p => [
        p.colors.primary.toLowerCase(), p.colors.accent.toLowerCase()]);
      if (new Set(colors).size !== colors.length) {
        $('#warn').textContent = 'Every color must be unique, so no two pieces look alike.';
        return;
      }
      startGame(chosen, players);
    };
  };

  paint();
}

function startGame(entry, players) {
  UI.entry = entry;
  UI.engine = new Engine(entry.ruleset, {
    players,
    seed: seedFromString(String(Date.now())),
  });
  UI.selected = null;
  UI.pendingTargets = null;
  UI.lastMove = null;

  UI.engine.onChange(() => { refresh(); });
  UI.board.attach(UI.engine);
  setWordmark(entry.name);
  closeModal();
  refresh();
}

/* ============================================================
   INTERACTION
   ============================================================ */

/** Every action available to the player on turn, with its geometry. */
function currentActions() {
  const eng = UI.engine;
  if (!eng || eng.isOver()) return [];
  const actor = eng.state.cur;
  return eng.legalActions(actor).map(action => ({
    action,
    actor,
    ...describe(action),
  }));
}

function describe(action) {
  const rs = UI.engine.ruleset;
  if (typeof rs.describeAction === 'function') {
    return rs.describeAction(UI.engine.state, action) || {};
  }
  return { from: null, to: null, label: action.type };
}

const same = (a, b) => a && b && a.x === b.x && a.y === b.y;

function onCellClick(cell, opts) {
  const eng = UI.engine;
  if (!eng || eng.isOver()) return;

  const actions = currentActions();

  // Inspect never commits to anything.
  if (opts.inspect) {
    UI.selected = cell;
    UI.pendingTargets = null;
    return refresh();
  }

  // If a square is selected, a click on one of its targets acts.
  if (UI.selected) {
    const hits = actions.filter(a => same(a.from, UI.selected) && same(a.to, cell));
    if (hits.length === 1) return commit(hits[0]);
    if (hits.length > 1) {
      // Several actions land here — let the player pick.
      UI.pendingTargets = hits;
      return refresh();
    }
  }

  // Actions with no origin (Territory's placement) act directly.
  const placements = actions.filter(a => !a.from && same(a.to, cell));
  if (placements.length === 1) return commit(placements[0]);
  if (placements.length > 1) {
    UI.pendingTargets = placements;
    return refresh();
  }

  // Otherwise treat the click as a selection.
  UI.selected = actions.some(a => same(a.from, cell)) ? cell : cell;
  UI.pendingTargets = null;
  refresh();
}

function commit(entry) {
  try {
    UI.engine.applyAction(entry.action, entry.actor);
    UI.lastMove = { from: entry.from, to: entry.to };
    UI.pendingTargets = null;
    // Keep the selection on the destination so chains feel continuous —
    // but only for actions that moved something. An action with no
    // origin (placing an opening piece) isn't a chain, and holding a
    // selection afterwards would hide the next player's own placement
    // highlights, so they'd never see where they are allowed to go.
    UI.selected = entry.from ? (entry.to || null) : null;
  } catch (err) {
    flash(err.message);
  }
  refresh();
}

/* ============================================================
   RENDER
   ============================================================ */

function refresh() {
  if (!UI.engine) return;
  const actions = currentActions();

  const marks = new Map();
  if (UI.lastMove) {
    if (UI.lastMove.from) marks.set(key(UI.lastMove.from), 'last');
    if (UI.lastMove.to) marks.set(key(UI.lastMove.to), 'last');
  }
  if (UI.selected) {
    marks.set(key(UI.selected), 'origin');
    for (const a of actions) {
      if (same(a.from, UI.selected) && a.to) marks.set(key(a.to), 'target');
    }
  }
  // Before anything is selected, show where a placement could go. This
  // gets its own mark rather than reusing 'target': a placement field
  // covers the whole viewport, and the dashed border that reads well on
  // a handful of move targets becomes noise at that scale.
  if (!UI.selected) {
    for (const a of actions) {
      if (!a.from && a.to) marks.set(key(a.to), 'place');
    }
  }

  UI.board.setHighlights(marks);
  UI.board.setSelected(UI.selected);
  UI.board.draw();
  renderPanel(actions);
}

const key = c => c.x + ',' + c.y;

function renderPanel(actions) {
  const eng = UI.engine;
  const st = eng.state;
  const rs = eng.ruleset;
  const over = eng.result();
  const summary = typeof rs.summarize === 'function' ? rs.summarize(st) : {};
  let h = '';

  if (over) {
    const who = over.winnerId === null ? 'Draw' : (eng.players[over.winnerId]?.name || 'Player ' + over.winnerId) + ' wins';
    h += `<div class="card"><div class="rowlab">result</div>
      <div class="turnname" style="margin:4px 0">${who}</div>
      <p class="hint">${over.reason}</p></div>`;
  } else {
    const actor = typeof rs.describeActor === 'function'
      ? rs.describeActor(st, st.cur)
      : { name: 'Player ' + st.cur, colors: null, status: '' };
    const tint = actor.colors?.primary || 'var(--brass)';
    h += `<div class="turnline">
      <span class="turnchip" style="background:${tint};box-shadow:0 0 12px ${tint}"></span>
      <div>
        <div class="turnname">${actor.name}</div>
        <div class="turnphase">${[summary.phase, summary.turnNo ? 'turn ' + summary.turnNo : '']
      .filter(Boolean).join(' · ')}</div>
      </div>
    </div>`;
    if (actor.status) h += `<div class="kv"><span>${actor.status}</span></div>`;
  }

  // Anything the ruleset chose to surface.
  const shown = Object.entries(summary).filter(([k]) =>
    !['phase', 'turnNo', 'current'].includes(k));
  if (shown.length && !over) {
    h += `<div class="card">${shown.map(([k, v]) =>
      `<div class="kv"><span>${k}</span><b>${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}</b></div>`).join('')}</div>`;
  }

  // A square with several competing actions asks which one.
  if (UI.pendingTargets) {
    h += `<div class="card"><div class="rowlab">which one?</div>
      <div class="btnrow" style="margin-top:8px">
        ${UI.pendingTargets.map((a, i) => `<button data-pick="${i}">${a.label}</button>`).join('')}
      </div>
      <p class="hint">More than one move lands on that square.</p></div>`;
  }

  // Actions that don't point at a square: end turn, trades, and so on.
  const loose = actions.filter(a => !a.to || (UI.selected && same(a.from, UI.selected) && same(a.to, UI.selected)));
  if (loose.length && !over) {
    h += `<div class="card"><div class="rowlab">actions</div>
      <div class="btnrow" style="margin-top:8px">
        ${loose.map((a, i) => `<button data-loose="${actions.indexOf(a)}">${a.label}</button>`).join('')}
      </div></div>`;
  }

  if (!UI.selected && !over) {
    h += `<p class="hint">Click a piece to see where it can go. <b>Shift-click</b> or <b>right-click</b> inspects without acting.</p>`;
  }

  // Roster
  h += `<div class="eyebrow" style="margin-top:18px">Table</div>`;
  h += eng.players.map((p, i) => {
    const a = typeof rs.describeActor === 'function' ? rs.describeActor(st, i) : null;
    const nm = a?.name || p.name || 'Player ' + i;
    return `<div class="ros ${a && a.alive === false ? 'dead' : ''}">
      <span class="sw"><i style="background:${p.colors?.primary || '#888'}"></i><i style="background:${p.colors?.accent || '#ccc'}"></i></span>
      <span class="nm">${nm}${i === st.cur && !over ? ' ←' : ''}</span>
      <span class="st">${a?.status || ''}</span>
    </div>`;
  }).join('');

  // Record
  h += `<div class="eyebrow" style="margin-top:18px">Record <span style="color:var(--mute)">click to rewind</span></div><div id="log">`;
  const lines = eng.log.slice(-60).reverse();
  h += lines.length
    ? lines.map((e, i) => {
      const idx = eng.log.length - 1 - i;
      return `<div class="undoable" data-undo="${idx}">${e.text}<span class="rew">↶</span></div>`;
    }).join('')
    : '<div>Nothing yet.</div>';
  h += `</div>`;

  $('#pbody').innerHTML = h;

  $('#pfoot').innerHTML = `
    <button class="primary" id="undo" ${eng.canUndo() ? '' : 'disabled'}>↶ Undo</button>
    <button id="rulesbtn" title="Rules">?</button>
    <button id="setbtn" title="Settings">⚙</button>
    <button id="codebtn" title="Ruleset code">&lt;/&gt;</button>
    <button id="themebtn" title="Your styling">🎨</button>
    <button id="newbtn" title="New game">⟲</button>`;

  bindPanel(actions);
}

function bindPanel(actions) {
  document.querySelectorAll('[data-pick]').forEach(b => {
    b.onclick = () => commit(UI.pendingTargets[+b.dataset.pick]);
  });
  document.querySelectorAll('[data-loose]').forEach(b => {
    b.onclick = () => commit(actions[+b.dataset.loose]);
  });
  document.querySelectorAll('[data-undo]').forEach(b => {
    b.onclick = () => {
      UI.engine.undoTo(+b.dataset.undo);
      UI.selected = null; UI.pendingTargets = null; UI.lastMove = null;
      refresh();
    };
  });
  $('#undo').onclick = () => {
    UI.engine.undo();
    UI.selected = null; UI.pendingTargets = null; UI.lastMove = null;
    refresh();
  };
  $('#rulesbtn').onclick = () => showRules(UI.engine.ruleset, null);
  $('#setbtn').onclick = showSettings;
  $('#codebtn').onclick = showCode;
  $('#themebtn').onclick = showTheme;
  $('#newbtn').onclick = confirmNew;
}

function flash(msg) {
  const el = $('#pbody');
  const note = document.createElement('div');
  note.className = 'warn';
  note.textContent = msg;
  el.prepend(note);
  setTimeout(() => note.remove(), 2600);
}

/* ============================================================
   MODALS
   ============================================================ */

/**
 * Resolve the modal element on first use rather than at boot. Anything
 * that opens a dialog before boot() has run would otherwise die on a
 * null, which is easy to hit and gives a blank page instead of an error.
 */
function modal(html) {
  // Re-resolve if the cached node is stale — it can be detached by a
  // re-render, and writing into an orphaned element fails silently,
  // which looks like "the dialog just didn't open".
  if (!modal.el || !modal.el.isConnected) modal.el = $('#modal');
  if (!modal.el) return;
  modal.el.innerHTML = html;
  $('#veil')?.classList.add('open');
}
modal.el = null;

function closeModal() {
  $('#veil')?.classList.remove('open');
}

/** A very small markdown subset — enough for the rules panels. */
function md(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, '<ul>$1</ul>')
    .replace(/^(?!<[hulc])(.+)$/gm, '<p>$1</p>');
}

function showRules(ruleset, back) {
  modal(`<div class="rules">
    <h2>${ruleset.name}</h2>
    <p class="sub">version ${ruleset.version}</p>
    ${ruleset.rulesText ? md(ruleset.rulesText) : '<p>This ruleset ships no rules text.</p>'}
    <div class="btnrow" style="margin-top:18px"><button class="primary" id="close">${back ? 'Back' : 'Close'}</button></div>
  </div>`);
  $('#close').onclick = () => (back ? back() : closeModal());
}

function showSettings() {
  const rs = UI.engine.ruleset;
  const cfg = UI.engine.config;
  const groups = (rs.configSpec || []).map(([title, rows]) => `
    <h3>${title}</h3>
    ${rows.map(([k, label, type]) => `
      <div class="srow">
        <label for="cf_${k}">${label}</label>
        ${type === 'bool'
      ? `<input type="checkbox" id="cf_${k}" ${cfg[k] ? 'checked' : ''}>`
      : type === 'text'
        ? `<input type="text" id="cf_${k}" value="${String(cfg[k] ?? '')}" style="width:260px">`
        : `<input type="number" id="cf_${k}" value="${cfg[k]}" step="1">`}
      </div>`).join('')}`).join('');

  modal(`<div class="rules">
    <h2>Playtest <span>settings</span></h2>
    <p class="sub">${rs.name} · changes apply to the game in progress</p>
    ${groups}
    <p class="hint">In an online match these lock when the game starts, so both
    sides stay on the same rules.</p>
    <div class="btnrow" style="margin-top:18px">
      <button class="primary" id="apply">Apply</button>
      <button id="close">Close</button>
    </div>
  </div>`);

  $('#apply').onclick = () => {
    for (const [, rows] of rs.configSpec || []) {
      for (const [k, , type] of rows) {
        const el = $('#cf_' + k);
        if (!el) continue;
        UI.engine.config[k] = type === 'bool' ? el.checked
          : type === 'text' ? el.value
            : Math.max(0, Number(el.value) || 0);
      }
    }
    // Live state carries its own copy for rulesets that snapshot config.
    if (UI.engine.state.config) Object.assign(UI.engine.state.config, UI.engine.config);
    closeModal();
    refresh();
  };
  $('#close').onclick = closeModal;
}

function showCode() {
  const rs = UI.engine.ruleset;
  modal(`<div class="rules">
    <h2>Ruleset <span>code</span></h2>
    <p class="sub">${rs.name} ${rs.version}</p>
    <p class="hint">This is the game's own source. Edit it, and the edited
    version is registered as a separate ruleset you can start a new game with.
    Running a ruleset someone else wrote runs their code in your browser — the
    same trust you'd give a userscript.</p>
    <textarea id="src" spellcheck="false">${
    (rs.source || '// This ruleset was loaded as a module.\n// Paste a full ruleset module here to register your own variant.\n')
      .replace(/</g, '&lt;')}</textarea>
    <div class="warn" id="cwarn"></div>
    <div class="btnrow" style="margin-top:12px">
      <button class="primary" id="load">Register this ruleset</button>
      <button id="close">Close</button>
    </div>
  </div>`);

  $('#load').onclick = async () => {
    const text = $('#src').value;
    const warn = $('#cwarn');
    try {
      // An error boundary matters here: a typo in a hand-edited ruleset
      // must show up as a message, not a blank page.
      const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
      const mod = await import(/* @vite-ignore */ url);
      URL.revokeObjectURL(url);
      const candidate = mod.default;
      if (!candidate) throw new Error('The module has no default export.');
      const entry = registerRuleset(candidate, {
        blurb: 'Your own variant.',
        minPlayers: UI.entry.minPlayers,
        maxPlayers: UI.entry.maxPlayers,
        defaultPlayers: UI.entry.defaultPlayers,
        custom: true,
      });
      warn.className = 'warn ok';
      warn.textContent = `Registered "${entry.name}". Start a new game to play it.`;
    } catch (err) {
      warn.className = 'warn';
      warn.textContent = err.message;
    }
  };
  $('#close').onclick = closeModal;
}

function showTheme() {
  const current = loadTheme();
  modal(`<div class="rules">
    <h2>Your <span>styling</span></h2>
    <p class="sub">Saved in this browser · never sent to your opponent</p>
    <p class="hint">The board is ordinary HTML, so any CSS works. Cells are
    <code>.cell</code>, pieces are <code>.piece</code> plus whatever classes the
    ruleset gives them, and counters are <code>.tag</code>.</p>
    <textarea id="css" spellcheck="false" placeholder=":root { --brass: #7EC8E3; }">${current || ''}</textarea>
    <div class="btnrow" style="margin-top:12px">
      <button class="primary" id="save">Apply and save</button>
      <button id="reset">Reset to default</button>
      <button id="close">Close</button>
    </div>
  </div>`);

  $('#save').onclick = () => { saveTheme($('#css').value); closeModal(); };
  $('#reset').onclick = () => { resetTheme(); $('#css').value = ''; };
  $('#close').onclick = closeModal;
}

function confirmNew() {
  // Nothing to lose before a game starts, or once one has finished.
  if (!UI.engine || UI.engine.isOver()) return openPicker();

  modal(`<div class="rules">
    <h2>Leave this <span>game?</span></h2>
    <p class="sub">${UI.entry ? UI.entry.name : ''}</p>
    <p>You'll go back to the game list. The board and the whole record go
    with it \u2014 there's no way back to this position afterwards.</p>
    <div class="btnrow" style="margin-top:18px">
      <button class="primary" id="yes">Leave and choose a game</button>
      <button id="no">Keep playing</button>
    </div></div>`);
  $('#yes').onclick = openPicker;
  $('#no').onclick = closeModal;
}

/* ============================================================
   BOOT
   ============================================================ */

export function boot() {
  applyTheme(loadTheme());

  UI.board = new BoardView($('#boardwrap'), {
    onCellClick,
    onCellHover: () => {},
  });

  const wordmark = $('#wordmark');
  if (wordmark) {
    wordmark.onclick = confirmNew;
    // It's a real control, so it should answer the keyboard too.
    wordmark.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmNew(); }
    };
  }

  $('#zin').onclick = () => UI.board.zoomAt(1.15, 0, 0);
  $('#zout').onclick = () => UI.board.zoomAt(1 / 1.15, 0, 0);
  $('#zhome').onclick = () => {
    if (UI.board.bounds()) UI.board.fit();
    else UI.board.panTo(0, 0);
  };

  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      UI.selected = null;
      UI.pendingTargets = null;
      if ($('#veil').classList.contains('open')) closeModal();
      refresh();
    }
    if ((e.key === 'z' && (e.metaKey || e.ctrlKey)) && UI.engine?.canUndo()) {
      e.preventDefault();
      UI.engine.undo();
      UI.selected = null; UI.lastMove = null;
      refresh();
    }
  });

  openPicker();
}

if (typeof document !== 'undefined' && document.getElementById('modal')) boot();

export { UI, onCellClick, currentActions, setWordmark, confirmNew, openPicker, refresh };
