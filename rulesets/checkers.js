/* checkers.js — English draughts (American checkers) as a ruleset.
 *
 * A deliberately different shape from Territory, to prove the engine
 * isn't quietly Territory-specific: a finite board, one action type,
 * two pieces, and a hard "you must capture if you can" rule.
 *
 * A whole jump sequence is ONE action, carried as a path of squares.
 * That matters: an engine that only understood from/to pairs would have
 * to invent a "mid-jump" phase, and undo would rewind half a capture.
 *
 * Board: 8x8, x = file 0..7, y = rank 0..7. Player 0 sits at y=0 and
 * moves up; player 1 sits at y=7 and moves down. Play is on dark squares
 * only, meaning (x + y) is odd.
 */

const K = (x, y) => x + ',' + y;
const un = k => k.split(',').map(Number);
const inBoard = (s, x, y) => x >= 0 && y >= 0 && x < s.config.size && y < s.config.size;
const at = (s, x, y) => s.board[K(x, y)] || null;

const config = {
  size: 8,
  rows: 3,                  // rows of pieces each player starts with
  mustCapture: true,        // captures are compulsory
  kingsFly: false,          // false = a king steps one square (English rules)
  menCaptureBackwards: true,// a man may jump backwards, as in English rules
  promotionEndsTurn: true,  // crowning stops a jump sequence dead
  drawAfterQuietMoves: 40,  // moves by each side with no capture or crowning
};

const configSpec = [
  ['Board', [
    ['size', 'Board size', 'num'],
    ['rows', 'Rows of pieces per player', 'num'],
  ]],
  ['Rules', [
    ['mustCapture', 'Captures are compulsory', 'bool'],
    ['kingsFly', 'Kings slide any distance (international rules)', 'bool'],
    ['menCaptureBackwards', 'Men may jump backwards', 'bool'],
    ['promotionEndsTurn', 'Crowning ends the turn mid-jump', 'bool'],
    ['drawAfterQuietMoves', 'Quiet moves before a draw is called', 'num'],
  ]],
];

const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const forward = pi => (pi === 0 ? 1 : -1);

/** Directions a piece may travel for a plain move. */
function stepDirs(s, piece) {
  if (piece.king) return DIAG;
  return DIAG.filter(([, dy]) => dy === forward(piece.o));
}

/** Directions a piece may jump in. */
function jumpDirs(s, piece) {
  if (piece.king || s.config.menCaptureBackwards) return DIAG;
  return DIAG.filter(([, dy]) => dy === forward(piece.o));
}

const crowningRank = (s, pi) => (pi === 0 ? s.config.size - 1 : 0);

/**
 * Every maximal jump sequence starting at (x,y). Returns paths as arrays
 * of squares beginning with the origin. A sequence ends when no further
 * jump is available — or immediately on crowning, if that ends the turn.
 */
function jumpPaths(s, x, y) {
  const start = at(s, x, y);
  if (!start) return [];
  const results = [];

  const walk = (cx, cy, piece, captured, path) => {
    let extended = false;
    for (const [dx, dy] of jumpDirs(s, piece)) {
      const mx = cx + dx, my = cy + dy;         // the square jumped over
      const lx = cx + dx * 2, ly = cy + dy * 2; // where we land
      if (!inBoard(s, lx, ly)) continue;
      const victim = at(s, mx, my);
      const landing = at(s, lx, ly);
      if (!victim || victim.o === piece.o) continue;
      if (captured.has(K(mx, my))) continue;    // no jumping the same man twice
      if (landing && !(landing.x === x && landing.y === y)) continue;

      const crowned = !piece.king && ly === crowningRank(s, piece.o);
      const next = crowned ? { ...piece, king: true } : piece;

      extended = true;
      const nextCaptured = new Set(captured).add(K(mx, my));
      const nextPath = path.concat([[lx, ly]]);

      if (crowned && s.config.promotionEndsTurn) {
        results.push(nextPath);            // the crown stops the sequence
      } else {
        walk(lx, ly, next, nextCaptured, nextPath);
      }
    }
    if (!extended && path.length > 1) results.push(path);
  };

  walk(x, y, start, new Set(), [[x, y]]);
  return results;
}

/** Plain one-square moves for a piece. */
function stepMoves(s, x, y) {
  const piece = at(s, x, y);
  if (!piece) return [];
  const out = [];
  for (const [dx, dy] of stepDirs(s, piece)) {
    if (piece.king && s.config.kingsFly) {
      for (let n = 1; ; n++) {
        const tx = x + dx * n, ty = y + dy * n;
        if (!inBoard(s, tx, ty) || at(s, tx, ty)) break;
        out.push([[x, y], [tx, ty]]);
      }
    } else {
      const tx = x + dx, ty = y + dy;
      if (inBoard(s, tx, ty) && !at(s, tx, ty)) out.push([[x, y], [tx, ty]]);
    }
  }
  return out;
}

function allPaths(s, pi) {
  const jumps = [], steps = [];
  for (const [k, piece] of Object.entries(s.board)) {
    if (piece.o !== pi) continue;
    const [x, y] = un(k);
    jumps.push(...jumpPaths(s, x, y));
    steps.push(...stepMoves(s, x, y));
  }
  if (s.config.mustCapture && jumps.length) return jumps;
  return jumps.concat(steps);
}

const pathKey = path => path.map(([x, y]) => K(x, y)).join('>');

function countPieces(s, pi) {
  let n = 0;
  for (const p of Object.values(s.board)) if (p.o === pi) n++;
  return n;
}


const rulesText = `
## The board

Eight by eight, played on the dark squares only. Each player starts with three
rows of **men**. Player one sits at the bottom and moves up; player two sits at
the top and moves down.

## Moving

A man steps one square diagonally forward onto an empty square. That is the
whole of a quiet move.

## Jumping

If an enemy piece sits diagonally adjacent and the square directly beyond it is
empty, you jump: hop over, land beyond, and remove what you jumped.

- **Jumping is compulsory.** If any jump is available anywhere, a quiet move is
  not offered.
- **A jump sequence runs to its end.** If the piece can jump again from where it
  lands, it must. The whole chain is a single turn — you cannot stop halfway.
- The same piece cannot be jumped twice in one sequence.

## Crowning

A man reaching the far rank is **crowned** a king, which may move and jump
backwards as well as forwards. Crowning ends the turn: a man that gets its crown
mid-sequence stops there, even if another jump was available.

## Winning

You lose when you have no pieces left, or when you have pieces but no legal move.
A long stretch with no capture and no crowning is called a draw.

## What can be changed

Compulsory capture, backward jumps for men, whether crowning stops a sequence,
flying kings (international rules), board size, and the number of starting rows
are all settings.
`;

/** A seat's colors, as CSS custom properties for the renderer. */
function colorsOf(state, id) {
  const c = state.players[id]?.colors || {};
  return {
    'unit-color': c.primary || (id === 0 ? '#E7EDE9' : '#2C3A38'),
    'armory-color': c.accent || '#C8A24A',
  };
}

const checkers = {
  id: 'checkers',
  name: 'Checkers',
  version: '1.0',
  config,
  configSpec,
  rulesText,

  createInitialState(config, rng, players = []) {
    const s = {
      config: structuredClone(config),
      board: {},
      players: players.map(p => ({ ...p })),
      cur: 0,
      turnNo: 1,
      quiet: 0,          // plies since the last capture or crowning
      result: null,
    };
    const size = config.size;
    for (let y = 0; y < config.rows; y++) {
      for (let x = 0; x < size; x++) {
        if ((x + y) % 2 === 1) s.board[K(x, y)] = { o: 0, king: false };
      }
    }
    for (let y = size - config.rows; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if ((x + y) % 2 === 1) s.board[K(x, y)] = { o: 1, king: false };
      }
    }
    return s;
  },

  legalActions(state, actorId, scope = null) {
    if (state.result || actorId !== state.cur) return [];
    let paths = allPaths(state, actorId);
    if (scope && scope.from) {
      const k = K(scope.from.x, scope.from.y);
      paths = paths.filter(p => K(p[0][0], p[0][1]) === k);
    }
    return paths.map(path => ({ type: 'move', path: pathKey(path) }));
  },

  isLegal(state, action, actorId) {
    if (state.result || actorId !== state.cur || action.type !== 'move') return false;
    return allPaths(state, actorId).some(p => pathKey(p) === action.path);
  },

  applyAction(state, action, rng) {
    const s = state, log = [];
    const path = action.path.split('>').map(un);
    const [x0, y0] = path[0];
    const piece = at(s, x0, y0);
    let cur = { ...piece };
    let captures = 0;

    delete s.board[K(x0, y0)];
    for (let i = 1; i < path.length; i++) {
      const [px, py] = path[i - 1];
      const [tx, ty] = path[i];
      if (Math.abs(tx - px) > 1) {
        // A jump: everything hopped over on the way is taken.
        const dx = Math.sign(tx - px), dy = Math.sign(ty - py);
        for (let n = 1; n < Math.abs(tx - px); n++) {
          const k = K(px + dx * n, py + dy * n);
          if (s.board[k]) { delete s.board[k]; captures++; }
        }
      }
      if (!cur.king && ty === crowningRank(s, cur.o)) cur = { ...cur, king: true };
    }
    const [fx, fy] = path[path.length - 1];
    s.board[K(fx, fy)] = cur;

    const crowned = cur.king && !piece.king;
    log.push(`${s.players[s.cur]?.name || 'Player ' + s.cur} ${captures ? `jumped ${captures}` : 'moved'} ${x0},${y0} → ${fx},${fy}${crowned ? ' and was crowned' : ''}.`);

    s.quiet = (captures || crowned) ? 0 : s.quiet + 1;
    s.cur = (s.cur + 1) % 2;
    s.turnNo++;

    // A player with nothing left, or nothing legal to do, has lost.
    const opponent = s.cur;
    if (countPieces(s, opponent) === 0) {
      s.result = { winnerId: 1 - opponent, reason: 'every piece captured' };
      log.push(`${s.players[1 - opponent]?.name || 'Player ' + (1 - opponent)} wins — no pieces left.`);
    } else if (allPaths(s, opponent).length === 0) {
      s.result = { winnerId: 1 - opponent, reason: 'no legal move' };
      log.push(`${s.players[1 - opponent]?.name || 'Player ' + (1 - opponent)} wins — opponent is stuck.`);
    } else if (s.config.drawAfterQuietMoves > 0 && s.quiet >= s.config.drawAfterQuietMoves * 2) {
      s.result = { winnerId: null, reason: 'no capture or crowning for a long while' };
      log.push('Drawn — nothing has happened for too long.');
    }
    return log;
  },

  describeAction(state, a) {
    const squares = a.path.split('>').map(un);
    const [fx, fy] = squares[0];
    const [tx, ty] = squares[squares.length - 1];
    const jumps = squares.length - 1;
    return {
      from: { x: fx, y: fy },
      to: { x: tx, y: ty },
      label: jumps > 1 ? `Jump \u00d7${jumps}` : (Math.abs(tx - fx) > 1 ? 'Jump' : 'Move'),
      group: 'move',
    };
  },

  isTerminal(state) {
    return state.result;
  },

  describeCell(state, x, y) {
    const p = at(state, x, y);
    if (!p) return null;
    return {
      ownerId: p.o,
      label: p.king ? 'KING' : 'MAN',
      classes: ['piece', p.o === 0 ? 'light' : 'dark', p.king ? 'king' : 'man'],
      glyph: p.king ? '♚' : '●',
      colors: colorsOf(state, p.o),
      stackHeight: p.king ? 2 : 1,
    };
  },

  describeActor(state, id) {
    const p = state.players[id];
    return {
      name: p?.name || 'Player ' + id,
      colors: p?.colors || {},
      status: `${countPieces(state, id)} pieces`,
      alive: !state.result || state.result.winnerId === id,
    };
  },

  bounds(state) {
    return { x0: 0, y0: 0, x1: state.config.size - 1, y1: state.config.size - 1 };
  },

  summarize(state) {
    return {
      turnNo: state.turnNo, current: state.cur,
      pieces: [countPieces(state, 0), countPieces(state, 1)],
      quiet: state.quiet,
    };
  },

  helpers: { K, un, at, allPaths, jumpPaths, pathKey, countPieces },
};

export default checkers;
