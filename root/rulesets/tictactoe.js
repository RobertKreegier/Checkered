/* tictactoe.js — Tic Tac Toe.
 * ===========================================================
 *
 * THIS FILE IS MEANT TO BE READ. If you want to make your own game for
 * this engine, start here. Territory, Checkers, and Chess are real games
 * with real complexity; this one is small enough to hold in your head.
 *
 * -----------------------------------------------------------
 * THE IDEA
 * -----------------------------------------------------------
 *
 * The engine knows nothing about any game. It doesn't know what a mark
 * is, or that three in a row wins. All it knows is how to ask questions,
 * and a "ruleset" is an object that answers them:
 *
 *   "How does a new game start?"      -> createInitialState()
 *   "What can this player do now?"    -> legalActions()
 *   "They did this — what happens?"   -> applyAction()
 *   "Is the game over?"               -> isTerminal()
 *   "What should I draw here?"        -> describeCell()
 *
 * Answer those five questions and you have a working game: the board
 * draws itself, clicking works, undo works, the record works, and the
 * AI can play it. You don't write any of that.
 *
 * -----------------------------------------------------------
 * THINGS TO KNOW BEFORE YOU START
 * -----------------------------------------------------------
 *
 * 1. THE STATE IS EVERYTHING. Whatever you put in the object returned by
 *    createInitialState() *is* the game. Don't keep information anywhere
 *    else — not in a variable at the top of this file, not on the page.
 *    If it isn't in the state, undo and replay will lose it.
 *
 * 2. NO RANDOMNESS OF YOUR OWN. Never call Math.random(). If you need a
 *    dice roll, use the `rng` the engine hands you. That is what lets a
 *    game be replayed exactly, which the whole engine depends on.
 *
 * 3. NO CLOCK, NO PAGE. Don't use Date.now() and don't touch the
 *    document. A ruleset has to be able to run with no browser at all.
 *
 * 4. COORDINATES ARE (x, y), x rightward and y upward, and they're
 *    stored as the string "x,y". So the middle of a 3x3 board is "1,1".
 */

/* -----------------------------------------------------------
 * SMALL HELPERS
 * -----------------------------------------------------------
 * The board is a plain object, like { "0,0": 0, "1,1": 1 }, where the
 * value is which player owns that square. These two functions turn
 * coordinates into keys and back.
 */

/** Turn x and y into the key we store the square under. */
const key = (x, y) => `${x},${y}`;

/** Turn a key back into a pair of numbers. */
const coords = k => k.split(',').map(Number);

/** Read a square. Returns the player's number, or undefined if empty. */
const at = (state, x, y) => state.board[key(x, y)];

/* -----------------------------------------------------------
 * WORKING OUT WHO HAS WON
 * -----------------------------------------------------------
 *
 * Look outward from a square in one direction and back the other way,
 * counting how many squares in a row belong to the same player. If the
 * run is long enough, that's a line.
 *
 * There are four directions worth checking: across, up, and the two
 * diagonals. We don't check the opposite four (left, down, and so on)
 * because a line running left is the same line running right.
 */
const DIRECTIONS = [
  [1, 0],   // across
  [0, 1],   // up
  [1, 1],   // diagonal, bottom-left to top-right
  [1, -1],  // diagonal, top-left to bottom-right
];

/**
 * How many squares in a row `player` has through (x, y) in one
 * direction, counting the starting square once.
 */
function runLength(state, x, y, dx, dy, player) {
  let count = 1;

  // Walk forward while the squares keep belonging to this player.
  for (let step = 1; at(state, x + dx * step, y + dy * step) === player; step++) {
    count++;
  }
  // Then walk backward from the starting square.
  for (let step = 1; at(state, x - dx * step, y - dy * step) === player; step++) {
    count++;
  }

  return count;
}

/** Did the mark just played at (x, y) complete a line? */
function makesLine(state, x, y, player) {
  const needed = state.config.inARow;
  return DIRECTIONS.some(([dx, dy]) => runLength(state, x, y, dx, dy, player) >= needed);
}

/** Is every square taken? */
function boardIsFull(state) {
  return Object.keys(state.board).length >= state.config.size * state.config.size;
}

/* -----------------------------------------------------------
 * RULES TEXT
 * -----------------------------------------------------------
 * Shown in the app when someone presses the "?" button. Plain text with
 * a bit of Markdown. Keeping it in the same file as the code is
 * deliberate — it's much harder for the rules and the behaviour to drift
 * apart when they're side by side.
 */
const rulesText = `
## The game

Two players take turns claiming empty squares. The first to get three in
a row — across, up and down, or diagonally — wins. If every square is
taken and nobody has three in a row, it is a draw.

## The settings

Under the settings button you can change:

- **Board size** — make it 4x4 or 5x5 instead of 3x3.
- **How many in a row** — four in a row on a 5x5 board is a better game
  than three in a row, which the first player can always win.
- **Misère** — inverts the goal: making a line *loses*. Same game,
  one line of code different, and it plays nothing like the original.

## If you are reading the code

This ruleset is written as a worked example. Open the ruleset code
button and read from the top — it explains how a game is put together
for this engine, and it is short enough to follow in one sitting.
`;

/* -----------------------------------------------------------
 * THE RULESET
 * -----------------------------------------------------------
 * Everything above was preparation. This object is the actual game.
 */
const tictactoe = {
  /* --- identity ------------------------------------------ */

  id: 'tictactoe',       // must be unique across all rulesets
  name: 'Tic Tac Toe',
  version: '1.0.0',
  rulesText,

  /* --- settings ------------------------------------------ */

  /**
   * The numbers a player is allowed to change. Anything here shows up in
   * the settings dialog automatically. Give every setting a sensible
   * default: this object *is* the default game.
   */
  config: {
    size: 3,        // the board is size x size
    inARow: 3,      // how many in a row you need to win
    misere: false,  // when true, making a line loses instead of winning
  },

  /**
   * How the settings dialog should present each setting: a group title,
   * then rows of [key, label, type]. Types are 'num', 'bool', or 'text'.
   */
  configSpec: [
    ['Board', [
      ['size', 'Squares along each side', 'num'],
      ['inARow', 'How many in a row wins', 'num'],
    ]],
    ['Variant', [
      ['misere', 'Misère — making a line loses', 'bool'],
    ]],
  ],

  /* --- starting a game ----------------------------------- */

  /**
   * Build a brand new game.
   *
   * `config` is the settings above, with any changes the player made.
   * `rng` is the seeded random source — unused here, since nothing in
   * Tic Tac Toe is random. `players` is who is at the table.
   *
   * Whatever you return here is the entire game. Note that we store a
   * copy of the config inside the state: that way a saved game carries
   * the rules it was played under.
   */
  createInitialState(config, rng, players = []) {
    return {
      config: { ...config },
      board: {},                                  // "x,y" -> player number
      players: players.map(p => ({ ...p })),
      cur: 0,                                     // whose turn it is
      winner: null,                               // filled in when someone wins
      reason: null,                               // and why
    };
  },

  /* --- what can be done ---------------------------------- */

  /**
   * Every action `actorId` could legally take right now.
   *
   * The engine uses this for three separate things: to know what is
   * allowed, to highlight squares on the board, and to give the AI its
   * options. So this one function is most of the game.
   *
   * An "action" is any plain object you like, as long as it has a
   * `type`. Ours look like: { type: 'mark', x: 1, y: 2 }
   */
  legalActions(state, actorId) {
    // Nothing is legal once the game is decided.
    if (state.winner !== null || state.reason) return [];

    // Nothing is legal for someone who isn't on turn.
    if (actorId !== state.cur) return [];

    const actions = [];
    for (let x = 0; x < state.config.size; x++) {
      for (let y = 0; y < state.config.size; y++) {
        // You may claim any square nobody has claimed yet.
        if (at(state, x, y) === undefined) {
          actions.push({ type: 'mark', x, y });
        }
      }
    }
    return actions;
  },

  /* --- doing it ------------------------------------------ */

  /**
   * Carry out an action. This is the only place the game changes.
   *
   * Change `state` directly — the engine has already taken a copy for
   * undo, so you don't need to be careful about that. Return an array of
   * strings and they become lines in the record down the side.
   *
   * You can trust that the action is legal: the engine checks it against
   * legalActions() before calling this.
   */
  applyAction(state, action, rng) {
    const player = state.cur;
    const who = state.players[player]?.name || `Player ${player + 1}`;
    const log = [];

    // 1. Claim the square.
    state.board[key(action.x, action.y)] = player;
    log.push(`${who} took ${action.x},${action.y}.`);

    // 2. Did that finish the game?
    if (makesLine(state, action.x, action.y, player)) {
      if (state.config.misere) {
        // Misère: the line you just made is your undoing. The winner is
        // whoever else is at the table.
        state.winner = (player + 1) % state.players.length;
        state.reason = `${who} made a line, which loses in misère.`;
      } else {
        state.winner = player;
        state.reason = `${who} got ${state.config.inARow} in a row.`;
      }
      log.push(state.reason);
      return log;
    }

    if (boardIsFull(state)) {
      state.winner = null;
      state.reason = 'Every square is taken.';
      log.push('A draw.');
      return log;
    }

    // 3. Nobody has won, so it is the next player's turn.
    state.cur = (state.cur + 1) % state.players.length;
    return log;
  },

  /* --- is it over? --------------------------------------- */

  /**
   * Return null while the game is still going. When it is finished,
   * return { winnerId, reason }. A winnerId of null means a draw.
   */
  isTerminal(state) {
    if (!state.reason) return null;
    return { winnerId: state.winner, reason: state.reason };
  },

  /* --- drawing ------------------------------------------- */

  /**
   * Describe one square so the board can draw it. Return null for an
   * empty square.
   *
   * Notice that this returns *data*, never HTML. You say "this belongs
   * to player 0, draw it with these classes, show this character"; the
   * stylesheet decides what that actually looks like. That's what lets a
   * player restyle the whole game with their own CSS.
   */
  describeCell(state, x, y) {
    const owner = at(state, x, y);
    if (owner === undefined) return null;

    return {
      ownerId: owner,
      glyph: owner === 0 ? '✕' : '◯',
      // These become CSS classes on the piece, so `.piece.nought` and
      // `.piece.cross` can be styled separately if anyone wants to.
      classes: ['mark', owner === 0 ? 'cross' : 'nought'],
      colors: {
        'unit-color': state.players[owner]?.colors?.primary || '#E7EDE9',
      },
    };
  },

  /**
   * The board is a fixed size, so tell the engine where its edges are.
   * It will fit the board to the window and stop you panning off into
   * empty space. (Territory leaves this out, which is what makes it
   * an infinite board.)
   */
  bounds(state) {
    return { x0: 0, y0: 0, x1: state.config.size - 1, y1: state.config.size - 1 };
  },

  /* --- optional extras ----------------------------------- */
  /* Everything below here is optional. The game works without it; it
   * just works *better* with it. */

  /**
   * Where an action points, so the interface can offer it without
   * understanding it. `from` is where a piece starts (nothing, here —
   * marks appear out of nowhere) and `to` is where it lands.
   */
  describeAction(state, action) {
    return {
      from: null,
      to: { x: action.x, y: action.y },
      label: `Take ${action.x},${action.y}`,
    };
  },

  /** A line or two about each player, shown in the panel. */
  describeActor(state, id) {
    const p = state.players[id] || {};
    const owned = Object.values(state.board).filter(o => o === id).length;
    return {
      name: p.name || `Player ${id + 1}`,
      colors: p.colors || {},
      status: `${owned} square${owned === 1 ? '' : 's'}`,
    };
  },

  /** Whatever you want shown at the top of the panel. */
  summarize(state) {
    const taken = Object.keys(state.board).length;
    return {
      phase: state.reason ? 'finished' : 'playing',
      squaresLeft: state.config.size * state.config.size - taken,
    };
  },

  /**
   * Every square that has something on it. The AI needs this to survey
   * the board — describeCell() can only answer about a square you
   * already know about.
   */
  occupiedCells(state) {
    return Object.keys(state.board).map(k => {
      const [x, y] = coords(k);
      return { x, y };
    });
  },

  /**
   * How good a position is, from one player's point of view. Higher is
   * better for them.
   *
   * This is optional — leave it out and the engine uses a generic guess
   * based on who owns more. But a generic guess is poor at Tic Tac Toe,
   * where owning more squares means nothing and *where* they are means
   * everything. So we count threats instead: a line of two that could
   * still become three is worth something; a line of three has won.
   *
   * Writing one of these is usually how you turn a bot that shuffles
   * aimlessly into one that plays properly.
   */
  evaluate(state, actorId) {
    const done = this.isTerminal(state);
    if (done) {
      if (done.winnerId === actorId) return 1000;
      if (done.winnerId === null) return 0;
      return -1000;
    }

    // Count how threatening each player's position is.
    let score = 0;
    for (const k of Object.keys(state.board)) {
      const [x, y] = coords(k);
      const owner = state.board[k];
      let best = 0;
      for (const [dx, dy] of DIRECTIONS) {
        best = Math.max(best, runLength(state, x, y, dx, dy, owner));
      }
      // A run of two is worth more than twice a run of one, because it
      // is one move from winning.
      const worth = best * best;
      score += owner === actorId ? worth : -worth;
    }

    // In misère everything you want is reversed, so flip the sign.
    return state.config.misere ? -score : score;
  },
};

export default tictactoe;
