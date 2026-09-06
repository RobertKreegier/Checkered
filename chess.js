/* chess.js — chess as a ruleset.
 *
 * The hardest test of the engine contract so far, because chess breaks
 * several assumptions Territory never touched:
 *   - legality depends on the position AFTER the move (you may not leave
 *     your own king in check), so generation is filter-then-offer
 *   - a move's meaning depends on history (castling rights, en passant)
 *   - the game can end in a draw with both kings on the board
 *
 * Coordinates: x = file 0..7 (a..h), y = rank 0..7 (rank 1..8).
 * Player 0 is White at the bottom; player 1 is Black at the top.
 * Pieces are stored as immutable little objects {o, p}, p in "pnbrqk",
 * so a board can be shallow-copied safely during search.
 */

const K = (x, y) => x + ',' + y;
const un = k => k.split(',').map(Number);
const onBoard = (x, y) => x >= 0 && y >= 0 && x < 8 && y < 8;
const at = (s, x, y) => s.board[K(x, y)] || null;

const config = {
  // The opening position, as FEN. Starting elsewhere goes through config
  // rather than an extra argument, so that (ruleset, config, seed,
  // players, actions) still fully describes a game — the same rule that
  // made players an Engine option.
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  drawByFiftyMoves: true,
  drawByRepetition: true,
  drawByInsufficientMaterial: true,
};

const configSpec = [
  ['Position', [
    ['fen', 'Opening position (FEN)', 'text'],
  ]],
  ['Draws', [
    ['drawByFiftyMoves', 'Draw after fifty quiet moves', 'bool'],
    ['drawByRepetition', 'Draw on threefold repetition', 'bool'],
    ['drawByInsufficientMaterial', 'Draw when neither side can mate', 'bool'],
  ]],
];

const N_DIRS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const B_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const R_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const Q_DIRS = B_DIRS.concat(R_DIRS);

const FILES = 'abcdefgh';
const sq = (x, y) => FILES[x] + (y + 1);
const pawnDir = o => (o === 0 ? 1 : -1);
const homeRank = o => (o === 0 ? 1 : 6);
const lastRank = o => (o === 0 ? 7 : 0);

/* ---------- attack detection ---------- */

/** Is (x,y) attacked by `by`? Used for check and for castling squares. */
function attacked(s, x, y, by) {
  // pawns
  const dy = -pawnDir(by);
  for (const dx of [-1, 1]) {
    const p = at(s, x + dx, y + dy);
    if (p && p.o === by && p.p === 'p') return true;
  }
  // knights
  for (const [dx, dy2] of N_DIRS) {
    const p = at(s, x + dx, y + dy2);
    if (p && p.o === by && p.p === 'n') return true;
  }
  // king
  for (const [dx, dy2] of Q_DIRS) {
    const p = at(s, x + dx, y + dy2);
    if (p && p.o === by && p.p === 'k') return true;
  }
  // sliders
  for (const [dirs, kinds] of [[B_DIRS, 'bq'], [R_DIRS, 'rq']]) {
    for (const [dx, dy2] of dirs) {
      for (let n = 1; n < 8; n++) {
        const tx = x + dx * n, ty = y + dy2 * n;
        if (!onBoard(tx, ty)) break;
        const p = at(s, tx, ty);
        if (!p) continue;
        if (p.o === by && kinds.includes(p.p)) return true;
        break;
      }
    }
  }
  return false;
}

function findKing(s, o) {
  for (const [k, p] of Object.entries(s.board)) {
    if (p.o === o && p.p === 'k') return un(k);
  }
  return null;
}

function inCheck(s, o) {
  const k = findKing(s, o);
  return k ? attacked(s, k[0], k[1], 1 - o) : false;
}

/* ---------- move generation ---------- */

/** Moves ignoring whether they leave our own king in check. */
function pseudoMoves(s, o) {
  const out = [];
  const add = (x, y, tx, ty, extra = {}) => out.push({ type: 'move', x, y, tx, ty, ...extra });

  for (const [k, piece] of Object.entries(s.board)) {
    if (piece.o !== o) continue;
    const [x, y] = un(k);

    if (piece.p === 'p') {
      const d = pawnDir(o), promo = lastRank(o);
      const one = [x, y + d];
      if (onBoard(...one) && !at(s, ...one)) {
        if (one[1] === promo) for (const q of 'qrbn') add(x, y, one[0], one[1], { promo: q });
        else {
          add(x, y, one[0], one[1]);
          const two = [x, y + 2 * d];
          if (y === homeRank(o) && !at(s, ...two)) add(x, y, two[0], two[1], { double: true });
        }
      }
      for (const dx of [-1, 1]) {
        const tx = x + dx, ty = y + d;
        if (!onBoard(tx, ty)) continue;
        const target = at(s, tx, ty);
        if (target && target.o !== o) {
          if (ty === promo) for (const q of 'qrbn') add(x, y, tx, ty, { promo: q });
          else add(x, y, tx, ty);
        } else if (!target && s.ep === K(tx, ty)) {
          add(x, y, tx, ty, { ep: true });
        }
      }
      continue;
    }

    if (piece.p === 'n' || piece.p === 'k') {
      const dirs = piece.p === 'n' ? N_DIRS : Q_DIRS;
      for (const [dx, dy] of dirs) {
        const tx = x + dx, ty = y + dy;
        if (!onBoard(tx, ty)) continue;
        const t = at(s, tx, ty);
        if (!t || t.o !== o) add(x, y, tx, ty);
      }
      if (piece.p === 'k') {
        // Castling: rights intact, path empty, and the king may not start
        // in check, pass through an attacked square, or land in one.
        const rights = s.castle[o];
        const rank = o === 0 ? 0 : 7;
        if (x === 4 && y === rank && !inCheck(s, o)) {
          if (rights.k
            && !at(s, 5, rank) && !at(s, 6, rank)
            && !attacked(s, 5, rank, 1 - o) && !attacked(s, 6, rank, 1 - o)) {
            add(x, y, 6, rank, { castle: 'k' });
          }
          if (rights.q
            && !at(s, 3, rank) && !at(s, 2, rank) && !at(s, 1, rank)
            && !attacked(s, 3, rank, 1 - o) && !attacked(s, 2, rank, 1 - o)) {
            add(x, y, 2, rank, { castle: 'q' });
          }
        }
      }
      continue;
    }

    const dirs = piece.p === 'b' ? B_DIRS : piece.p === 'r' ? R_DIRS : Q_DIRS;
    for (const [dx, dy] of dirs) {
      for (let n = 1; n < 8; n++) {
        const tx = x + dx * n, ty = y + dy * n;
        if (!onBoard(tx, ty)) break;
        const t = at(s, tx, ty);
        if (!t) { add(x, y, tx, ty); continue; }
        if (t.o !== o) add(x, y, tx, ty);
        break;
      }
    }
  }
  return out;
}

/**
 * Carry out a move on a state. Shared by generation (on a throwaway
 * copy) and by applyAction, so the two can never drift apart.
 */
function makeMove(s, m) {
  const piece = at(s, m.x, m.y);
  const captured = m.ep ? at(s, m.tx, m.y) : at(s, m.tx, m.ty);
  const o = piece.o;

  delete s.board[K(m.x, m.y)];
  if (m.ep) delete s.board[K(m.tx, m.y)];
  s.board[K(m.tx, m.ty)] = m.promo ? { o, p: m.promo } : piece;

  if (m.castle) {
    const rank = o === 0 ? 0 : 7;
    const [rx, nrx] = m.castle === 'k' ? [7, 5] : [0, 3];
    const rook = at(s, rx, rank);
    delete s.board[K(rx, rank)];
    s.board[K(nrx, rank)] = rook;
  }

  // Castling rights die when the king or a rook leaves its square, and
  // when a rook is captured on its home square.
  if (piece.p === 'k') s.castle[o] = { k: false, q: false };
  if (piece.p === 'r') {
    if (m.x === 0 && m.y === (o === 0 ? 0 : 7)) s.castle[o].q = false;
    if (m.x === 7 && m.y === (o === 0 ? 0 : 7)) s.castle[o].k = false;
  }
  const foe = 1 - o, foeRank = foe === 0 ? 0 : 7;
  if (m.tx === 0 && m.ty === foeRank) s.castle[foe].q = false;
  if (m.tx === 7 && m.ty === foeRank) s.castle[foe].k = false;

  s.ep = m.double ? K(m.x, m.y + pawnDir(o)) : null;
  s.halfmove = (piece.p === 'p' || captured) ? 0 : s.halfmove + 1;
  if (o === 1) s.fullmove++;
  s.cur = 1 - o;

  return { piece, captured };
}

/** A cheap copy for try-it-and-see legality checks. */
function cloneForTrial(s) {
  return {
    config: s.config,
    board: { ...s.board },
    castle: [{ ...s.castle[0] }, { ...s.castle[1] }],
    ep: s.ep,
    halfmove: s.halfmove,
    fullmove: s.fullmove,
    cur: s.cur,
  };
}

/** Pseudo-legal moves minus the ones that leave our own king in check. */
function legalMoves(s, o) {
  const out = [];
  for (const m of pseudoMoves(s, o)) {
    const t = cloneForTrial(s);
    makeMove(t, m);
    if (!inCheck(t, o)) out.push(m);
  }
  return out;
}

/* ---------- draws ---------- */

/** A compact description of a position, for repetition detection. */
function positionKey(s) {
  const cells = Object.keys(s.board).sort()
    .map(k => k + (s.board[k].o === 0 ? 'w' : 'b') + s.board[k].p).join('|');
  const rights = `${s.castle[0].k ? 'K' : ''}${s.castle[0].q ? 'Q' : ''}${s.castle[1].k ? 'k' : ''}${s.castle[1].q ? 'q' : ''}` || '-';
  return `${cells} ${s.cur} ${rights} ${s.ep || '-'}`;
}

function insufficientMaterial(s) {
  const bishops = [[], []];
  let minor = [0, 0];
  for (const [k, p] of Object.entries(s.board)) {
    if (p.p === 'k') continue;
    if (p.p === 'p' || p.p === 'r' || p.p === 'q') return false;
    minor[p.o]++;
    if (p.p === 'b') {
      const [x, y] = un(k);
      bishops[p.o].push((x + y) % 2);
    }
  }
  if (minor[0] === 0 && minor[1] === 0) return true;          // bare kings
  if (minor[0] + minor[1] === 1) return true;                  // lone minor
  // King and bishop against king and bishop, both on one color.
  if (minor[0] === 1 && minor[1] === 1 && bishops[0].length === 1 && bishops[1].length === 1) {
    return bishops[0][0] === bishops[1][0];
  }
  return false;
}

/* ---------- FEN ---------- */

const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function loadFEN(fen) {
  const [placement, side, rights, ep, half, full] = fen.trim().split(/\s+/);
  const board = {};
  const rows = placement.split('/');
  rows.forEach((row, i) => {
    const y = 7 - i;
    let x = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { x += Number(ch); continue; }
      board[K(x, y)] = { o: ch === ch.toUpperCase() ? 0 : 1, p: ch.toLowerCase() };
      x++;
    }
  });
  return {
    board,
    cur: side === 'w' ? 0 : 1,
    castle: [
      { k: rights.includes('K'), q: rights.includes('Q') },
      { k: rights.includes('k'), q: rights.includes('q') },
    ],
    ep: ep && ep !== '-' ? K(FILES.indexOf(ep[0]), Number(ep[1]) - 1) : null,
    halfmove: Number(half ?? 0),
    fullmove: Number(full ?? 1),
  };
}

function toFEN(s) {
  let placement = '';
  for (let y = 7; y >= 0; y--) {
    let run = 0;
    for (let x = 0; x < 8; x++) {
      const p = at(s, x, y);
      if (!p) { run++; continue; }
      if (run) { placement += run; run = 0; }
      placement += p.o === 0 ? p.p.toUpperCase() : p.p;
    }
    if (run) placement += run;
    if (y) placement += '/';
  }
  const rights = `${s.castle[0].k ? 'K' : ''}${s.castle[0].q ? 'Q' : ''}${s.castle[1].k ? 'k' : ''}${s.castle[1].q ? 'q' : ''}` || '-';
  const ep = s.ep ? sq(...un(s.ep)) : '-';
  return `${placement} ${s.cur === 0 ? 'w' : 'b'} ${rights} ${ep} ${s.halfmove} ${s.fullmove}`;
}

/** Standard algebraic-ish notation, enough to read a log by. */
function notate(s, m, piece, captured) {
  if (m.castle) return m.castle === 'k' ? 'O-O' : 'O-O-O';
  const take = captured ? 'x' : '';
  if (piece.p === 'p') {
    const from = take ? FILES[m.x] : '';
    return `${from}${take}${sq(m.tx, m.ty)}${m.promo ? '=' + m.promo.toUpperCase() : ''}${m.ep ? ' e.p.' : ''}`;
  }
  return `${piece.p.toUpperCase()}${take}${sq(m.tx, m.ty)}`;
}

/* ============================================================
   THE RULESET
   ============================================================ */

const rulesText = `
## Standard chess

The ordinary rules, in full: piece movement, castling on both sides, en passant,
and pawn promotion to any of queen, rook, bishop, or knight.

## Check and checkmate

You may not make a move that leaves your own king attacked — pinned pieces
simply have no legal moves. If you are attacked and no legal move exists, that
is **checkmate** and you lose.

## Draws

- **Stalemate** — no legal move while not in check.
- **Fifty-move rule** — a hundred plies with no capture and no pawn move.
- **Threefold repetition** — the same position, with the same side to move, the
  same castling rights and the same en passant square, three times over.
- **Insufficient material** — neither side has the pieces to force mate: bare
  kings, a lone minor piece, or same-colour bishops.

Each of these can be switched off in settings.

## Starting elsewhere

The opening position is a setting, given as FEN. Paste any position in to study
it, or to hand a friend a puzzle instead of a fresh game.

## Notation

The record uses ordinary algebraic notation, with \`+\` for check, \`#\` for mate,
and \`O-O\` / \`O-O-O\` for castling.
`;

const chess = {
  id: 'chess',
  name: 'Chess',
  version: '1.0',
  config,
  configSpec,
  rulesText,

  createInitialState(config, rng, players = []) {
    const base = loadFEN(config.fen || FEN_START);
    return {
      config: structuredClone(config),
      players: players.map(p => ({ ...p })),
      ...base,
      history: [],       // position keys, for threefold repetition
      result: null,
    };
  },

  legalActions(state, actorId, scope = null) {
    if (state.result || actorId !== state.cur) return [];
    let moves = legalMoves(state, actorId);
    if (scope && scope.from) {
      moves = moves.filter(m => m.x === scope.from.x && m.y === scope.from.y);
    }
    return moves;
  },

  isLegal(state, action, actorId) {
    if (state.result || actorId !== state.cur || action.type !== 'move') return false;
    return legalMoves(state, actorId).some(m =>
      m.x === action.x && m.y === action.y &&
      m.tx === action.tx && m.ty === action.ty &&
      (m.promo || null) === (action.promo || null));
  },

  applyAction(state, action, rng) {
    const s = state, log = [];
    // Use our own generated move, so flags (ep, castle, double) are the
    // ruleset's own and not something a caller could spoof.
    const move = legalMoves(s, s.cur).find(m =>
      m.x === action.x && m.y === action.y &&
      m.tx === action.tx && m.ty === action.ty &&
      (m.promo || null) === (action.promo || null));
    if (!move) throw new Error('No such legal move.');

    const mover = s.cur;
    const { piece, captured } = makeMove(s, move);
    const text = notate(s, move, piece, captured);

    s.history.push(positionKey(s));

    const opponent = s.cur;
    const replies = legalMoves(s, opponent);
    const checked = inCheck(s, opponent);

    let suffix = '';
    if (!replies.length) {
      if (checked) {
        s.result = { winnerId: mover, reason: 'checkmate' };
        suffix = '#';
      } else {
        s.result = { winnerId: null, reason: 'stalemate' };
      }
    } else if (checked) {
      suffix = '+';
    }

    log.push(`${s.players[mover]?.name || (mover === 0 ? 'White' : 'Black')}: ${text}${suffix}`);

    if (!s.result) {
      const c = s.config;
      if (c.drawByFiftyMoves && s.halfmove >= 100) {
        s.result = { winnerId: null, reason: 'fifty-move rule' };
      } else if (c.drawByRepetition) {
        const key = s.history[s.history.length - 1];
        if (s.history.filter(h => h === key).length >= 3) {
          s.result = { winnerId: null, reason: 'threefold repetition' };
        }
      }
      if (!s.result && c.drawByInsufficientMaterial && insufficientMaterial(s)) {
        s.result = { winnerId: null, reason: 'insufficient material' };
      }
    }

    if (s.result) {
      log.push(s.result.winnerId === null
        ? `Drawn — ${s.result.reason}.`
        : `${s.players[s.result.winnerId]?.name || (s.result.winnerId === 0 ? 'White' : 'Black')} wins by ${s.result.reason}.`);
    }
    return log;
  },

  describeAction(state, a) {
    const names = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
    let label = `${sq(a.x, a.y)}\u2013${sq(a.tx, a.ty)}`;
    if (a.castle) label = a.castle === 'k' ? 'Castle kingside' : 'Castle queenside';
    else if (a.promo) label = `Promote to ${names[a.promo]}`;
    else if (a.ep) label = 'Capture en passant';
    return {
      from: { x: a.x, y: a.y },
      to: { x: a.tx, y: a.ty },
      label,
      group: a.promo ? 'promotion' : 'move',
    };
  },

  isTerminal(state) {
    return state.result;
  },

  describeCell(state, x, y) {
    const p = at(state, x, y);
    if (!p) return null;
    const glyphs = {
      0: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
      1: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
    };
    const names = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
    return {
      ownerId: p.o,
      label: names[p.p].toUpperCase(),
      classes: ['piece', p.o === 0 ? 'white' : 'black', names[p.p]],
      glyph: glyphs[p.o][p.p],
      colors: {
        'unit-color': state.players[p.o]?.colors?.primary || (p.o === 0 ? '#E7EDE9' : '#2C3A38'),
      },
    };
  },

  describeActor(state, id) {
    const p = state.players[id];
    const name = p?.name || (id === 0 ? 'White' : 'Black');
    const check = !state.result && state.cur === id && inCheck(state, id);
    return {
      name,
      colors: p?.colors || {},
      status: check ? 'in check' : `${Object.values(state.board).filter(q => q.o === id).length} pieces`,
      alive: !state.result || state.result.winnerId !== 1 - id,
    };
  },

  bounds() {
    return { x0: 0, y0: 0, x1: 7, y1: 7 };
  },

  summarize(state) {
    return {
      turnNo: state.fullmove,
      current: state.cur,
      fen: toFEN(state),
      check: inCheck(state, state.cur),
      halfmove: state.halfmove,
    };
  },

  helpers: {
    K, un, at, sq, attacked, inCheck, legalMoves, pseudoMoves,
    makeMove, cloneForTrial, loadFEN, toFEN, positionKey,
    insufficientMaterial, FEN_START,
  },
};

export default chess;
