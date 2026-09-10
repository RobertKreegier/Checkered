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
import { validateRuleset } from './ruleset-api.js';
import { seedFromString } from './rng.js';
import { applyTheme, loadTheme, saveTheme, resetTheme, THEME_KEY } from './theme.js';
import { allAis, getAi, takeTurn, positionHash, seededRandom, DEFAULT_WEIGHTS } from './ai-api.js';
// Importing this registers the searching bot, which is what puts it in
// the opponent list beside Greedy.
import './ai-search.js';
import { hostMatch, joinMatch, decodeMove, encodeMove } from './match.js';
import {
  snapshot, restore, encodeSave, decodeSave, describeSave, saveFilename,
  autosave, loadAutosave, clearAutosave, hasResumable,
  listSaves, saveSlot, loadSlot, deleteSlot,
} from './saves.js';

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

  /** Per seat: null for a person, or an AI id. */
  seats: [],
  aiWeights: { ...DEFAULT_WEIGHTS },
  thinking: false,        // an AI is mid-turn; the board is not yours
  aiSeen: null,           // positions this AI turn has already occupied
  aiTimer: null,

  /** Set when playing someone else by passing codes back and forth. */
  match: null,
  online: false,          // rules are pinned; live editing is refused
  invite: null,           // the code that invited the other player
};

/* ============================================================
   SETUP
   ============================================================ */

function openPicker() {
  clearAiTimer();
  UI.match = null;
  UI.online = false;
  UI.pendingCodes = [];
  setWordmark('');
  const games = allRulesets();
  let chosen = games[0];
  let count = Math.max(2, chosen.minPlayers);
  // Second seat defaults to a bot, so a lone visitor has an opponent
  // without having to work out how to arrange one. Prefer the searching
  // one when it is available — it is the better game.
  const bots = allAis();
  const preferred = (bots.find(b => b.id === 'search') || bots[0])?.id || null;
  const seats = [null, preferred, null, null];

  const paint = () => {
    // `seatRows` is the markup; `seats` above is who plays each one.
    const seatRows = Array.from({ length: count }, (_, i) => {
      const d = chosen.defaultPlayers[i]
        || { name: 'Player ' + (i + 1), colors: { primary: '#888888', accent: '#cccccc' } };
      const bots = allAis();
      return `<div class="prow">
        <span class="idx">${i + 1}</span>
        <input type="text" id="nm${i}" value="${d.name}" maxlength="14">
        <select id="ct${i}" title="who plays this seat">
          <option value="">Person</option>
          ${bots.map(b => `<option value="${b.id}" ${seats[i] === b.id ? 'selected' : ''}>${b.name} bot</option>`).join('')}
        </select>
        <input type="color" id="uc${i}" value="${d.colors?.primary || '#888888'}" title="main color">
        <input type="color" id="ac${i}" value="${d.colors?.accent || '#cccccc'}" title="accent color">
      </div>`;
    }).join('');

    const range = [];
    for (let n = chosen.minPlayers; n <= chosen.maxPlayers; n++) range.push(n);

    modal(`
      <h2>Checkered</h2>
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
      ${seatRows}
      <div class="warn" id="warn"></div>
      <div class="btnrow" style="margin-top:12px">
        <button class="primary" id="go">Set the board</button>
        <button id="rules">Read the rules</button>
      </div>
      ${resumeHtml()}
      <div class="eyebrow" style="margin-top:20px">Play someone else</div>
      <p class="hint" style="margin-top:0">No account and no server: you send
      your friend a code, they send one back, and the game keeps step. Works
      over any chat app.</p>
      <div class="btnrow" style="margin-top:8px">
        <button id="host">Invite a friend</button>
        <button id="joinbtn">I have an invitation</button>
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
    for (let i = 0; i < count; i++) {
      const sel = $('#ct' + i);
      if (sel) sel.onchange = () => { seats[i] = sel.value || null; };
    }
    $('#rules').onclick = () => showRules(chosen.ruleset, paint);
    const resume = $('#resume');
    if (resume) {
      resume.onclick = () => {
        try {
          adoptSave(loadAutosave());
        } catch (err) {
          $('#warn').textContent = err.message;
        }
      };
      $('#discard').onclick = () => { clearAutosave(); paint(); };
    }
    const saved = $('#opensaves');
    if (saved) saved.onclick = () => showSaves(paint);
    $('#host').onclick = () => startHosting(chosen, readSeats(count));
    $('#joinbtn').onclick = () => showJoin();
    $('#go').onclick = () => {
      const players = [];
      for (let i = 0; i < count; i++) {
        players.push({
          name: ($('#nm' + i).value || 'Player ' + (i + 1)).trim(),
          colors: { primary: $('#uc' + i).value, accent: $('#ac' + i).value },
        });
        seats[i] = $('#ct' + i)?.value || null;
      }
      const colors = players.flatMap(p => [
        p.colors.primary.toLowerCase(), p.colors.accent.toLowerCase()]);
      if (new Set(colors).size !== colors.length) {
        $('#warn').textContent = 'Every color must be unique, so no two pieces look alike.';
        return;
      }
      startGame(chosen, players, seats.slice(0, count));
    };
  };

  paint();
}

/** The "you were in the middle of something" offer. */
function resumeHtml() {
  const stored = listSaves();
  const resumable = hasResumable() ? describeSave(loadAutosave()) : null;
  if (!resumable && !stored.length) return '';

  let h = '<div class="eyebrow" style="margin-top:20px">Carry on</div>';
  if (resumable) {
    h += `<div class="card" style="margin-bottom:8px">
      <div class="rowlab">a game in progress</div>
      <div class="stackname" style="font-size:20px">${resumable.game}</div>
      <div class="kv"><span>${resumable.players}</span><b>${resumable.moves} move${
      resumable.moves === 1 ? '' : 's'}</b></div>
      <div class="btnrow" style="margin-top:8px">
        <button class="primary" id="resume">Pick up where you left off</button>
        <button id="discard">Forget it</button>
      </div>
    </div>`;
  }
  if (stored.length) {
    h += `<div class="btnrow"><button id="opensaves">Saved games (${stored.length})</button></div>`;
  }
  return h;
}

/** Read the player rows out of the picker. */
function readSeats(count) {
  const players = [];
  for (let i = 0; i < count; i++) {
    const nm = $('#nm' + i);
    players.push({
      name: (nm?.value || 'Player ' + (i + 1)).trim(),
      colors: {
        primary: $('#uc' + i)?.value || '#888888',
        accent: $('#ac' + i)?.value || '#cccccc',
      },
    });
  }
  return players;
}

function startGame(entry, players, seats = []) {
  clearAiTimer();
  UI.entry = entry;
  UI.engine = new Engine(entry.ruleset, {
    players,
    seed: seedFromString(String(Date.now())),
  });
  UI.selected = null;
  UI.pendingTargets = null;
  UI.lastMove = null;
  UI.seats = players.map((_, i) => seats[i] || null);
  UI.thinking = false;
  UI.aiSeen = null;
  // Seeded, so a game against a bot replays like any other.
  UI.aiRandom = seededRandom(UI.engine.seed ^ 0x5f3759df);

  UI.engine.onChange(() => { touchAutosave(); refresh(); });
  UI.board.attach(UI.engine);
  setWordmark(entry.name);
  clearAutosave();          // a new game replaces whatever was in progress
  closeModal();
  refresh();
  maybeRunAi();
}

/* ============================================================
   KEEPING THE GAME
   ============================================================ */

/** Everything needed to rebuild what is on the board right now. */
function currentSnapshot(name = null) {
  if (!UI.engine || !UI.entry) return null;
  return snapshot(UI.engine, {
    entry: UI.entry,
    name,
    seats: UI.match ? [...UI.match.localSeats] : null,
    pin: UI.match ? UI.match.pin : null,
  });
}

/**
 * Write the game down after every move.
 *
 * Debounced, because a Territory turn is a hundred actions and each one
 * fires a change — writing a hundred times a turn would be pointless and
 * slow. A short delay collapses them into one.
 */
let saveTimer = null;
function touchAutosave() {
  if (!UI.engine || !UI.entry) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const save = currentSnapshot();
    // A refusal here is almost always a full quota. It must not
    // interrupt the game, so it is noted and nothing more.
    if (save && !autosave(save)) UI.storageFull = true;
  }, 250);
}

/** Put a restored game on the board. */
function adoptSave(save) {
  const { entry, engine } = restore(save);
  clearAiTimer();
  UI.match = null;
  UI.online = false;
  UI.entry = entry;
  UI.engine = engine;
  UI.seats = save.seats ? [] : (UI.seats || []);
  UI.selected = null;
  UI.pendingTargets = null;
  UI.lastMove = null;
  UI.thinking = false;
  UI.pendingCodes = [];

  engine.onChange(() => { touchAutosave(); refresh(); });
  UI.board.attach(engine);
  setWordmark(entry.name);
  closeModal();
  refresh();
}

/* ============================================================
   PLAYING SOMEONE ELSE
   ============================================================ */

/** Take a live match and put it on the board. */
function adoptMatch(match, entry) {
  clearAiTimer();
  UI.match = match;
  UI.entry = entry;
  UI.online = true;              // rules are pinned for the match
  UI.seats = [];                 // no bots in a match
  UI.thinking = false;
  UI.engine = match.engine;
  UI.selected = null;
  UI.pendingTargets = null;
  UI.lastMove = null;

  match.onChange(() => {
    // The match replaces its engine when it catches up on missed moves,
    // so re-read it rather than holding a stale reference.
    if (UI.engine !== match.engine) {
      UI.engine = match.engine;
      UI.board.attach(UI.engine);
    }
    touchAutosave();
    refresh();
  });

  UI.board.attach(UI.engine);
  setWordmark(entry.name);
  closeModal();
  refresh();
}

function startHosting(entry, players) {
  const { match, invite } = hostMatch({
    entry,
    config: {},
    players: players.slice(0, 2),
    hostSeat: 0,
  });
  UI.invite = invite;
  adoptMatch(match, entry);
  showInvite();
}

/** The invitation, ready to be sent to whoever you are playing. */
function showInvite() {
  modal(`<div class="rules">
    <h2>Send this <span>invitation</span></h2>
    <p class="sub">${UI.entry.name} \u00b7 you play first</p>
    <p>Send this to whoever you are playing. They paste it into
    <b>I have an invitation</b> and the two of you are on the same board.</p>
    <textarea id="invite" spellcheck="false" style="min-height:120px">${UI.invite}</textarea>
    <div class="btnrow" style="margin-top:12px">
      <button class="primary" id="copy">Copy the invitation</button>
      <button id="close">Start playing</button>
    </div>
    <p class="hint">Nothing is sent anywhere. The code carries the game, the
    settings, and the shuffle, so both sides build the same board from it.</p>
  </div>`);
  $('#copy').onclick = () => copyFrom($('#invite'), $('#copy'), 'Copy the invitation');
  $('#close').onclick = closeModal;
}

function showJoin() {
  modal(`<div class="rules">
    <h2>Join a <span>game</span></h2>
    <p class="sub">Paste the invitation you were sent</p>
    <textarea id="code" spellcheck="false" style="min-height:120px"
      placeholder="Paste the invitation here"></textarea>
    <div class="warn" id="jwarn"></div>
    <div class="btnrow" style="margin-top:12px">
      <button class="primary" id="join">Join</button>
      <button id="back">Back</button>
    </div>
  </div>`);

  $('#join').onclick = () => {
    try {
      const { match, descriptor } = joinMatch($('#code').value);
      const entry = getRuleset(descriptor.rulesetId);
      adoptMatch(match, entry);
    } catch (err) {
      $('#jwarn').textContent = err.message;
    }
  };
  $('#back').onclick = openPicker;
}

/** Copy a field, and say so on the button so the click feels answered. */
function copyFrom(field, button, label) {
  field.select();
  const done = () => {
    if (!button) return;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = label; }, 1400);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(field.value).then(done, () => {});
  } else if (document.execCommand) {
    document.execCommand('copy');
    done();
  }
}

/** Take whatever the match wants to send and show it as one code. */
function outgoingCode() {
  if (!UI.match) return null;
  const pending = UI.match.drain();
  if (pending.length) UI.pendingCodes = (UI.pendingCodes || []).concat(pending);
  if (!UI.pendingCodes?.length) return null;
  return UI.pendingCodes.map(encodeMove).join('\n');
}

/** Feed in a code that arrived from the other player. */
function receiveCode(text) {
  const warn = $('#mwarn');
  const lines = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!lines.length) return;
  try {
    for (const line of lines) UI.match.receive(decodeMove(line));
    // Their reply means our last move landed, so stop offering it.
    UI.pendingCodes = [];
    UI.selected = null;
    UI.pendingTargets = null;
    if (warn) warn.textContent = '';
    refresh();
  } catch (err) {
    if (warn) warn.textContent = `That code could not be read: ${err.message}`;
  }
}

/* ============================================================
   THE BOT
   ============================================================ */

const seatIsAi = i => !!UI.seats[i];

function clearAiTimer() {
  if (UI.aiTimer) clearTimeout(UI.aiTimer);
  UI.aiTimer = null;
}

/**
 * Let a bot take its turn, one action at a time.
 *
 * Deliberately not a single synchronous playTurn(): a Territory turn can
 * be a hundred actions and take over a second, which would freeze the
 * page and show the player nothing but a stalled board. Stepping through
 * with a timeout between actions lets each move render as it happens, so
 * the turn reads as a sequence of decisions rather than a hang.
 */
function maybeRunAi() {
  clearAiTimer();
  const eng = UI.engine;
  if (!eng || eng.isOver()) { UI.thinking = false; return; }

  const actor = eng.state.cur;
  if (!seatIsAi(actor)) {
    if (UI.thinking) { UI.thinking = false; refresh(); }
    UI.aiSeen = null;
    return;
  }

  const entry = getAi(UI.seats[actor]);
  if (!entry) { UI.thinking = false; return; }

  if (!UI.thinking) {
    UI.thinking = true;
    UI.selected = null;
    UI.pendingTargets = null;
    refresh();
  }

  if (!UI.aiSeen) UI.aiSeen = new Set([positionHash(eng.state)]);

  UI.aiTimer = setTimeout(() => {
    const ai = entry.create(UI.aiWeights);
    let action = null;
    try {
      action = takeTurn(eng, ai, actor, UI.aiRandom, UI.aiSeen);
    } catch (err) {
      // A bot that misbehaves shouldn't strand the game. Say so and
      // hand control back rather than leaving the board frozen.
      UI.thinking = false;
      UI.seats[actor] = null;
      flash(`${entry.name} failed: ${err.message}. That seat is now yours.`);
      refresh();
      return;
    }

    if (!action) { UI.thinking = false; UI.aiSeen = null; refresh(); return; }

    // Going in circles: end the turn rather than loop (see ai-api.js).
    const here = positionHash(eng.state);
    if (UI.aiSeen.has(here)) { UI.thinking = false; UI.aiSeen = null; refresh(); return; }
    UI.aiSeen.add(here);

    if (eng.state.cur !== actor) UI.aiSeen = null;
    maybeRunAi();
  }, 180);
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
  // The board belongs to the bot until its turn is over. Inspecting is
  // still fine — reading the position while it plays is harmless.
  if (UI.thinking && !opts.inspect) return;
  if (seatIsAi(eng.state.cur) && !opts.inspect) return;
  // The other player's turn, or a paused match: look, don't touch.
  if (UI.match && !UI.match.canAct() && !opts.inspect) return;

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
    if (UI.match) {
      // In a match every move goes through the match layer, which
      // applies it here and produces the code to send onward.
      UI.match.act(entry.action, entry.actor);
    } else {
      UI.engine.applyAction(entry.action, entry.actor);
    }
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
  maybeRunAi();
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

  if (UI.board.mount) UI.board.mount.classList.toggle('waiting', !!UI.thinking);
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
    if (seatIsAi(st.cur)) {
      const bot = getAi(UI.seats[st.cur]);
      h += `<div class="card bot">
        <div class="rowlab">${bot ? bot.name : 'Bot'} is playing${UI.thinking ? '\u2026' : ''}</div>
        <p class="hint">${bot ? bot.description : ''}</p></div>`;
    }
  }

  // Anything the ruleset chose to surface.
  const shown = Object.entries(summary).filter(([k]) =>
    !['phase', 'turnNo', 'current'].includes(k));
  if (shown.length && !over) {
    h += `<div class="card">${shown.map(([k, v]) =>
      `<div class="kv"><span>${k}</span><b>${typeof v === 'boolean' ? (v ? 'yes' : 'no') : v}</b></div>`).join('')}</div>`;
  }

  if (UI.match) h += matchCardHtml();

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
      <span class="nm">${nm}${seatIsAi(i) ? ' <span class="botmark">bot</span>' : ''}${i === st.cur && !over ? ' ←' : ''}</span>
      <span class="st">${a?.status || ''}</span>
    </div>`;
  }).join('');

  // Record
  h += `<div class="eyebrow" style="margin-top:18px">Record <span style="color:var(--mute)">click to rewind</span></div><div id="log">`;
  const lines = eng.log.slice(-60).reverse();
  h += lines.length
    ? lines.map((e, i) => {
      const idx = eng.log.length - 1 - i;
      // Same reason: a rewind in a match is not ours alone to make.
      return UI.match
        ? `<div>${e.text}</div>`
        : `<div class="undoable" data-undo="${idx}">${e.text}<span class="rew">↶</span></div>`;
    }).join('')
    : '<div>Nothing yet.</div>';
  h += `</div>`;

  $('#pbody').innerHTML = h;

  // Undo is local, so in a match it would quietly put the two sides on
  // different boards — every move after it would be reported as a
  // disagreement, with no sign of the real cause. Rewinding a shared
  // game needs both players to agree, which is a feature, not a button.
  const canUndo = eng.canUndo() && !UI.match;
  $('#pfoot').innerHTML = `
    <button class="primary" id="undo" ${canUndo ? '' : 'disabled'}
      title="${UI.match ? 'Not while playing someone else' : 'Undo the last action'}">↶ Undo</button>
    <button id="rulesbtn" title="Rules">?</button>
    <button id="setbtn" title="Settings">⚙</button>
    <button id="codebtn" title="Ruleset code">&lt;/&gt;</button>
    <button id="savebtn" title="Saved games">💾</button>
    <button id="themebtn" title="Your styling">🎨</button>
    <button id="newbtn" title="New game">⟲</button>`;

  bindPanel(actions);
}

/**
 * The card that makes a code-passing game playable: what to send, and
 * somewhere to paste what comes back.
 */
function matchCardHtml() {
  const m = UI.match;

  if (m.status === 'diverged') {
    const r = m.divergenceReport();
    return `<div class="card diverged">
      <div class="rowlab">the match is paused</div>
      <div class="stackname" style="font-size:20px">${r.headline}</div>
      <p class="hint">${r.detail}</p>
      ${r.difference ? `<div class="kv"><span>first difference</span><b>${
        String(r.difference.path || r.difference).slice(0, 60)}</b></div>` : ''}
      ${r.ourHash ? `<div class="kv"><span>here</span><b>${String(r.ourHash).slice(0, 12)}</b></div>
        <div class="kv"><span>there</span><b>${String(r.theirHash).slice(0, 12)}</b></div>` : ''}
    </div>`;
  }

  const code = outgoingCode();
  const waiting = m.waitingOn();
  const over = m.engine.isOver();

  let h = `<div class="card match">
    <div class="rowlab">${
      over ? 'the game is over'
        : code ? 'send this to your opponent'
          : m.canAct() ? 'your move' : 'waiting for their move'}</div>`;

  if (code) {
    h += `<p class="hint">Send this to your opponent:</p>
      <textarea id="send" class="code" spellcheck="false" readonly>${code}</textarea>
      <div class="btnrow" style="margin:6px 0">
        <button class="primary" id="copysend">Copy</button>
      </div>`;
  } else if (m.canAct()) {
    h += `<p class="hint">Make your move, and a code to send will appear here.</p>`;
  }

  if (!over) {
    h += `<p class="hint">${waiting || 'Their reply goes here when it arrives.'}</p>
      <textarea id="recv" class="code" spellcheck="false"
        placeholder="Paste their code"></textarea>
      <div class="btnrow" style="margin-top:6px">
        <button id="apply-code">Play their move</button>
      </div>
      <div class="warn" id="mwarn"></div>`;
  }

  return h + `</div>`;
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
    if (UI.match) return;
    UI.engine.undo();
    UI.selected = null; UI.pendingTargets = null; UI.lastMove = null;
    refresh();
  };
  const send = $('#copysend');
  if (send) send.onclick = () => copyFrom($('#send'), send, 'Copy');
  const apply = $('#apply-code');
  if (apply) apply.onclick = () => receiveCode($('#recv').value);

  $('#rulesbtn').onclick = () => showRules(UI.engine.ruleset, null);
  $('#setbtn').onclick = showSettings;
  $('#codebtn').onclick = showCode;
  $('#savebtn').onclick = () => showSaves(null);
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

/** Tuning knobs for the bot, shown only when one is actually playing. */
function botKnobsHtml() {
  if (!UI.seats.some(Boolean)) return '';
  const spec = getAi(UI.seats.find(Boolean))?.weightSpec || [];
  if (!spec.length) return '';
  return `<h3>Bot</h3>
    ${spec.map(([k, label]) => `
      <div class="srow">
        <label for="w_${k}">${label}</label>
        <input type="number" id="w_${k}" step="0.1"
               value="${UI.aiWeights[k] ?? DEFAULT_WEIGHTS[k]}">
      </div>`).join('')}
    <p class="hint">Changing these changes how the bot plays its next move.
    It looks one move ahead and checks what can be taken straight back,
    so it will still walk into anything that takes two moves to punish.</p>`;
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
    ${botKnobsHtml()}
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
    for (const [k] of getAi(UI.seats.find(Boolean))?.weightSpec || []) {
      const el = $('#w_' + k);
      if (el) UI.aiWeights[k] = Number(el.value);
    }
    // Live state carries its own copy for rulesets that snapshot config.
    if (UI.engine.state.config) Object.assign(UI.engine.state.config, UI.engine.config);
    closeModal();
    refresh();
  };
  $('#close').onclick = closeModal;
}

/**
 * The ruleset's own source, editable while a game is running.
 *
 * Shows the real file rather than an empty box: the point of the feature
 * is that a player can read how the game works, change a rule, and see
 * what happens. Fetched at runtime, which is why the page has to be
 * served rather than opened from disk.
 */
async function showCode() {
  const rs = UI.engine.ruleset;
  const entry = UI.entry;

  modal(`<div class="rules">
    <h2>Ruleset <span>code</span></h2>
    <p class="sub">${rs.name} ${rs.version}</p>
    <p class="hint">This is the game's own source. Change it and either
    apply it to the game in progress, or register it as a separate ruleset
    to start fresh with. Running a ruleset someone else wrote runs their
    code in your browser — the same trust you would give a userscript.</p>
    <textarea id="src" spellcheck="false">Loading the source\u2026</textarea>
    <div class="warn" id="cwarn"></div>
    <div class="btnrow" style="margin-top:12px">
      <button class="primary" id="live">Apply to this game</button>
      <button id="load">Register as a new ruleset</button>
      <button id="revert">Revert</button>
      <button id="close">Close</button>
    </div>
  </div>`);

  const box = $('#src');
  const warn = $('#cwarn');
  const original = await loadSource(entry);
  box.value = original;

  const compile = async text => {
    // An error boundary matters here: a typo in a hand-edited ruleset
    // must surface as a message, not a blank page.
    const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
    try {
      const mod = await import(/* @vite-ignore */ url);
      if (!mod.default) throw new Error('The module has no default export.');
      return mod.default;
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const say = (msg, good) => {
    warn.className = good ? 'warn ok' : 'warn';
    warn.textContent = msg;
  };

  $('#live').onclick = async () => {
    try {
      const candidate = await compile(box.value);
      const problems = validateRuleset(candidate);
      if (problems.length) throw new Error(problems.join('; '));
      // Swap the rules under the running game. Legal in single player by
      // design — it is the whole point of live editing. In an online
      // match the rules are pinned at the start, so this is refused.
      if (UI.online) throw new Error('Rules are locked for the duration of an online match.');
      UI.engine.ruleset = candidate;
      UI.selected = null;
      UI.pendingTargets = null;
      say('Applied. The game is now running your version.', true);
      refresh();
    } catch (err) {
      say(err.message);
    }
  };

  $('#load').onclick = async () => {
    try {
      const candidate = await compile(box.value);
      const added = registerRuleset(candidate, {
        blurb: 'Your own variant.',
        minPlayers: entry.minPlayers,
        maxPlayers: entry.maxPlayers,
        defaultPlayers: entry.defaultPlayers,
        source: box.value,
        custom: true,
      });
      say(`Registered "${added.name}". Start a new game to play it.`, true);
    } catch (err) {
      say(err.message);
    }
  };

  $('#revert').onclick = () => { box.value = original; say('Back to the original.', true); };
  $('#close').onclick = closeModal;
}

/** Fetch a ruleset's source, falling back to whatever text it carries. */
async function loadSource(entry) {
  if (entry?.source) return entry.source;
  if (!entry?.sourceUrl) {
    return '// This ruleset was registered from memory and has no file.\n'
      + '// Paste a complete ruleset module here to replace it.\n';
  }
  try {
    const res = await fetch(entry.sourceUrl);
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return await res.text();
  } catch (err) {
    return `// Could not load ${entry.sourceUrl}\n// ${err.message}\n`
      + '//\n// Serving the folder over http is required; a page opened\n'
      + '// straight from disk cannot read its own source files.\n';
  }
}

/**
 * The player's own CSS.
 *
 * Opens showing something real rather than an empty box: if you have
 * written styling before, that; otherwise a starter sheet of the
 * variables and selectors actually in use, with the current values
 * filled in. The point is that you can see at a glance what there is to
 * change without having to go reading the stylesheet first.
 */
async function showTheme() {
  const current = loadTheme();

  modal(`<div class="rules">
    <h2>Your <span>styling</span></h2>
    <p class="sub">Saved in this browser · never sent to your opponent</p>
    <p class="hint">The board is ordinary HTML, so any CSS works. Squares
    are <code>.cell</code>, pieces are <code>.piece</code> plus whatever
    classes the ruleset gives them, stacked chips are <code>.chip</code>,
    and the counters are <code>.tag</code>.</p>
    <textarea id="css" spellcheck="false"></textarea>
    <div class="warn" id="twarn"></div>
    <div class="btnrow" style="margin-top:12px">
      <button class="primary" id="save">Apply and save</button>
      <button id="full">Load the full default sheet</button>
      <button id="reset">Reset to default</button>
      <button id="close">Close</button>
    </div>
  </div>`);

  const box = $('#css');
  const warn = $('#twarn');
  box.value = current || starterTheme();

  $('#save').onclick = () => { saveTheme(box.value); closeModal(); };

  $('#full').onclick = async () => {
    // The whole shipped stylesheet, for someone who wants to change
    // something the starter sheet doesn't mention. It is long, hence a
    // button rather than the default.
    try {
      const res = await fetch(new URL('./styles.css', import.meta.url).href);
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      box.value = '/* The shipped stylesheet. Anything you leave here\n'
        + '   overrides the default, so trimming this to just the rules\n'
        + '   you changed is kinder to the next person to read it. */\n\n'
        + await res.text();
      warn.className = 'warn ok';
      warn.textContent = 'Loaded. Edit freely — Reset puts everything back.';
    } catch (err) {
      warn.className = 'warn';
      warn.textContent = `Could not load the stylesheet: ${err.message}`;
    }
  };

  $('#reset').onclick = () => {
    resetTheme();
    box.value = starterTheme();
    warn.className = 'warn ok';
    warn.textContent = 'Back to the shipped look.';
  };
  $('#close').onclick = closeModal;
}

/**
 * A starter sheet showing what is there to change, with the values
 * currently in force read off the live page — so the numbers shown are
 *the ones actually in use rather than a guess written into this file.
 */
function starterTheme() {
  const seen = getComputedStyle(document.documentElement);
  const v = name => (seen.getPropertyValue(name) || '').trim();
  const vars = [
    ['--felt', 'the board'],
    ['--ink', 'page background'],
    ['--panel', 'the side panel'],
    ['--line', 'grid lines and borders'],
    ['--brass', 'highlights and accents'],
    ['--chalk', 'ordinary text'],
    ['--mute', 'quiet text'],
  ];

  return `/* Your own styling. Everything here is the current default —
   change a value, press Apply, and the board changes.
   Delete anything you do not want to override. */

:root {
${vars.map(([name, note]) => `  ${name}: ${v(name) || 'inherit'};`.padEnd(38) + ` /* ${note} */`).join('\n')}
}

/* Squares. The checker pattern is two rules: */
.cell.dark  { background: ${v('--square-dark') || 'rgba(255,255,255,.035)'}; }
.cell.light { background: ${v('--square-light') || 'transparent'}; }

/* Where you may move, and what you have picked up: */
.cell.hl-target { }
.cell.selected  { }

/* Pieces. Rulesets add their own classes — .stack, .king, .man,
   .neutral — so you can style one game without touching another: */
.piece { }

/* Chips in a Territory stack, and the little counters on a square: */
.chip { }
.tag  { }
`;
}

/**
 * Saved games: keep this one, open an old one, or move a game between
 * browsers as a code.
 */
function showSaves(back = null) {
  const saves = listSaves();
  const playing = !!(UI.engine && UI.entry);

  modal(`<div class="rules">
    <h2>Saved <span>games</span></h2>
    <p class="sub">Kept in this browser \u00b7 nothing is sent anywhere</p>

    ${playing ? `<h3>Keep this game</h3>
      <div class="prow" style="grid-template-columns:1fr 120px">
        <input type="text" id="savename" maxlength="40"
          placeholder="${UI.entry.name} \u2014 ${new Date().toLocaleDateString()}">
        <button class="primary" id="dosave">Save</button>
      </div>` : ''}

    <h3>Your saved games</h3>
    ${saves.length ? saves.map(s2 => {
    const d = describeSave(s2);
    return `<div class="srow">
        <label>
          <b>${d.name}</b><br>
          <span class="rowlab">${d.game} \u00b7 ${d.moves} moves \u00b7 ${
      d.when ? d.when.toLocaleString() : ''}${d.shared ? ' \u00b7 shared game' : ''}</span>
        </label>
        <span class="btnrow" style="flex:0 0 auto">
          <button data-open="${d.id}">Open</button>
          <button data-del="${d.id}">Delete</button>
        </span>
      </div>`;
  }).join('') : '<p class="hint">Nothing saved yet.</p>'}

    <h3>Move a game somewhere else</h3>
    <p class="hint">A saved game is a piece of text. Copy it into another
    browser, or send it to someone who wants to see the position.</p>
    <div class="btnrow" style="margin-bottom:8px">
      ${playing ? '<button id="export">Copy this game as a code</button>'
    + '<button id="download">Download it</button>' : ''}
    </div>
    <textarea id="savecode" class="code" spellcheck="false"
      placeholder="Paste a saved game here to open it"></textarea>
    <div class="warn" id="swarn2"></div>
    <div class="btnrow" style="margin-top:8px">
      <button class="primary" id="import">Open a pasted game</button>
      <button id="closesaves">${back ? 'Back' : 'Close'}</button>
    </div>
  </div>`);

  const warn = $('#swarn2');
  const say = (msg, good) => {
    warn.className = good ? 'warn ok' : 'warn';
    warn.textContent = msg;
  };

  const dosave = $('#dosave');
  if (dosave) {
    dosave.onclick = () => {
      const name = $('#savename').value.trim()
        || `${UI.entry.name} — ${new Date().toLocaleDateString()}`;
      const id = saveSlot(currentSnapshot(name), name);
      if (id) showSaves(back);
      else say('There was no room to save. Delete an old game and try again.');
    };
  }

  const exportBtn = $('#export');
  if (exportBtn) {
    exportBtn.onclick = () => {
      $('#savecode').value = encodeSave(currentSnapshot());
      copyFrom($('#savecode'), exportBtn, 'Copy this game as a code');
    };
  }

  const download = $('#download');
  if (download) {
    download.onclick = () => {
      const save = currentSnapshot();
      const blob = new Blob([encodeSave(save)], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = saveFilename(save);
      a.click();
      URL.revokeObjectURL(url);
    };
  }

  $('#import').onclick = () => {
    try {
      adoptSave(decodeSave($('#savecode').value));
    } catch (err) {
      say(err.message);
    }
  };

  modal.el.querySelectorAll('[data-open]').forEach(b => {
    b.onclick = () => {
      try {
        adoptSave(loadSlot(b.dataset.open));
      } catch (err) {
        say(err.message);
      }
    };
  });
  modal.el.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = () => { deleteSlot(b.dataset.del); showSaves(back); };
  });

  $('#closesaves').onclick = () => (back ? back() : closeModal());
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

export {
  UI, onCellClick, currentActions, setWordmark, confirmNew, openPicker,
  refresh, maybeRunAi, startGame, touchAutosave, currentSnapshot, adoptSave,
};
