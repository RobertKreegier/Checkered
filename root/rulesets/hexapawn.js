/* hexapawn.js — Hexapawn.
 * ===========================================================
 *
 * THE SECOND EXAMPLE. Read tictactoe.js first: it explains the five
 * questions a ruleset has to answer, and this file assumes you've seen
 * them.
 *
 * Tic Tac Toe is about *placing* things. This one is about *moving*
 * them, which is the other half of what grid games do. It is shorter
 * than Tic Tac Toe, because working out whether someone has won is
 * easier here than checking for lines.
 *
 * -----------------------------------------------------------
 * THE GAME
 * -----------------------------------------------------------
 *
 * A 3x3 board. Three pawns each, facing each other across it:
 *
 *      y=2   b b b        <- Black, moving downward
 *      y=1   . . .
 *      y=0   W W W        <- White, moving upward
 *            x: 0 1 2
 *
 * Pawns move exactly like chess pawns and nothing else: one square
 * straight forward onto an empty square, or one square diagonally
 * forward to capture. You win by getting a pawn to the far side, by
 * taking every enemy pawn, or by leaving your opponent with no move.
 *
 * Hexapawn was invented by Martin Gardner in 1962 to demonstrate a
 * machine that learns — it is small enough that a pile of matchboxes can
 * play it perfectly. Which also makes it small enough to read.
 *
 * -----------------------------------------------------------
 * THE NEW IDEA: DIRECTION
 * -----------------------------------------------------------
 *
 * Placement games don't care which way anyone faces. Movement games
 * usually do. The trick used here is worth stealing: each player gets a
 * `forward` of +1 or -1, and then a single piece of movement code works
 * for both sides. You never write the rules twice.
 */

const key = (x, y) => `${x},${y}`;
const coords = k => k.split(',').map(Number);

/** Read a square: the owning player's number, or undefined if empty. */
const at = (state, x, y) => state.board[key(x, y)];

/** Which way is forward for a player? Player 0 goes up, player 1 down. */
const forward = playerId => (playerId === 0 ? 1 : -1);

/** The row a player is trying to reach — the one their opponent starts on. */
const goalRow = (state, playerId) => (playerId === 0 ? state.config.size - 1 : 0);

/** Is this square on the board at all? */
const onBoard = (state, x, y) =>
  x >= 0 && y >= 0 && x < state.config.size && y < state.config.size;

/** How many pawns does a player still have? */
const pawnsLeft = (state, playerId) =>
  Object.values(state.board).filter(o => o === playerId).length;

const rulesText = `
## The game

Three pawns each, on a three by three board, facing each other.

- A pawn moves **one square straight forward** onto an empty square.
- A pawn **captures one square diagonally forward**, and only diagonally.
- A pawn never moves backward or sideways, and never captures straight
  ahead — the square in front of an enemy pawn is a wall to both of you.

## Winning

You win the moment any one of these happens:

- One of your pawns reaches the far row.
- You take your opponent's last pawn.
- Your opponent has no legal move on their turn.

That last one decides most games. Hexapawn is small enough that it is
solved: with perfect play the *second* player wins. Worth knowing before
you decide the bot is cheating.

## Where it comes from

Martin Gardner invented it in 1962 to show how a machine could learn a
game by being punished for losing moves — his version was played by a
row of matchboxes with coloured beads inside.

## If you are reading the code

This is the second of two worked examples. Tic Tac Toe shows how pieces
are *placed*; this one shows how they *move and capture*, which is the
part most games need and the part beginners usually get stuck on.
`;

const hexapawn = {
  id: 'hexapawn',
  name: 'Hexapawn',
  version: '1.0.0',
  rulesText,

  config: {
    size: 3,   // the board is size x size, with a full row of pawns each
  },

  configSpec: [
    ['Board', [
      ['size', 'Squares along each side', 'num'],
    ]],
  ],

  /**
   * Set the pawns out: player 0 along the bottom row, player 1 along the
   * top. Everything between them starts empty.
   */
  createInitialState(config, rng, players = []) {
    const state = {
      config: { ...config },
      board: {},
      players: players.map(p => ({ ...p })),
      cur: 0,
      winner: null,
      reason: null,
    };

    for (let x = 0; x < config.size; x++) {
      state.board[key(x, 0)] = 0;                  // bottom row
      state.board[key(x, config.size - 1)] = 1;    // top row
    }

    return state;
  },

  /**
   * Every move available to a player.
   *
   * This is the heart of a movement game, and it's only about fifteen
   * lines: for each pawn you own, look at the three squares in front of
   * it. Straight ahead if empty; the two diagonals if an enemy is there.
   */
  legalActions(state, actorId) {
    if (state.reason) return [];              // the game is finished
    if (actorId !== state.cur) return [];     // not your turn

    const actions = [];
    const dy = forward(actorId);

    for (const k of Object.keys(state.board)) {
      if (state.board[k] !== actorId) continue;   // not your pawn
      const [x, y] = coords(k);

      // Straight ahead, but only onto an empty square. A pawn cannot
      // capture forward — this is the rule that makes the game work,
      // because two pawns facing each other block each other completely.
      if (onBoard(state, x, y + dy) && at(state, x, y + dy) === undefined) {
        actions.push({ type: 'move', x, y, tx: x, ty: y + dy });
      }

      // Diagonally forward, but only onto an enemy. A pawn cannot move
      // diagonally to an empty square.
      for (const dx of [-1, 1]) {
        const tx = x + dx, ty = y + dy;
        if (!onBoard(state, tx, ty)) continue;
        const target = at(state, tx, ty);
        if (target !== undefined && target !== actorId) {
          actions.push({ type: 'move', x, y, tx, ty, capture: true });
        }
      }
    }

    return actions;
  },

  /**
   * Move a pawn, then check the three ways the game can end.
   *
   * Note the order: we work out whether the game is over *after* the
   * move has been made and *after* deciding whose turn it is next,
   * because "the opponent has no move" can only be asked once it is
   * actually their turn.
   */
  applyAction(state, action, rng) {
    const player = state.cur;
    const who = state.players[player]?.name || `Player ${player + 1}`;
    const opponent = (player + 1) % 2;
    const log = [];

    // Move the pawn. If something was standing there, it is simply
    // overwritten — that's the capture.
    delete state.board[key(action.x, action.y)];
    state.board[key(action.tx, action.ty)] = player;

    log.push(action.capture
      ? `${who} took the pawn on ${action.tx},${action.ty}.`
      : `${who} advanced to ${action.tx},${action.ty}.`);

    // Ending 1: a pawn reached the far side.
    if (action.ty === goalRow(state, player)) {
      state.winner = player;
      state.reason = `${who} reached the far row.`;
      log.push(state.reason);
      return log;
    }

    // Ending 2: the opponent has no pawns left.
    if (pawnsLeft(state, opponent) === 0) {
      state.winner = player;
      state.reason = `${who} took the last enemy pawn.`;
      log.push(state.reason);
      return log;
    }

    // Hand the turn over.
    state.cur = opponent;

    // Ending 3: the opponent has pawns, but nowhere to go. Being unable
    // to move is a loss here, not a draw — a small rule with a large
    // effect, since it is how most games of Hexapawn actually finish.
    if (this.legalActions(state, opponent).length === 0) {
      state.winner = player;
      const stuck = state.players[opponent]?.name || `Player ${opponent + 1}`;
      state.reason = `${stuck} has no move left.`;
      log.push(state.reason);
    }

    return log;
  },

  isTerminal(state) {
    if (!state.reason) return null;
    return { winnerId: state.winner, reason: state.reason };
  },

  describeCell(state, x, y) {
    const owner = at(state, x, y);
    if (owner === undefined) return null;

    return {
      ownerId: owner,
      glyph: '♟',
      classes: ['pawn', owner === 0 ? 'light' : 'dark'],
      colors: {
        'unit-color': state.players[owner]?.colors?.primary
          || (owner === 0 ? '#E7EDE9' : '#2C3A38'),
      },
    };
  },

  bounds(state) {
    return { x0: 0, y0: 0, x1: state.config.size - 1, y1: state.config.size - 1 };
  },

  /**
   * Here `from` matters, unlike in Tic Tac Toe. It is what tells the
   * interface to highlight where a pawn can go when you click it.
   */
  describeAction(state, action) {
    return {
      from: { x: action.x, y: action.y },
      to: { x: action.tx, y: action.ty },
      label: action.capture ? 'Capture' : 'Advance',
    };
  },

  describeActor(state, id) {
    const p = state.players[id] || {};
    const left = pawnsLeft(state, id);
    return {
      name: p.name || `Player ${id + 1}`,
      colors: p.colors || {},
      status: `${left} pawn${left === 1 ? '' : 's'}`,
    };
  },

  summarize(state) {
    return {
      phase: state.reason ? 'finished' : 'playing',
      pawns: `${pawnsLeft(state, 0)} v ${pawnsLeft(state, 1)}`,
    };
  },

  occupiedCells(state) {
    return Object.keys(state.board).map(k => {
      const [x, y] = coords(k);
      return { x, y };
    });
  },

  /**
   * What a position is worth.
   *
   * Two things matter in Hexapawn: how many pawns you have, and how far
   * up the board they are — a pawn one step from the far row is a threat
   * that has to be answered. The generic evaluator the engine falls back
   * on would only count pawns, and would happily let one walk past.
   */
  evaluate(state, actorId) {
    const done = this.isTerminal(state);
    if (done) return done.winnerId === actorId ? 1000 : -1000;

    let score = 0;
    for (const k of Object.keys(state.board)) {
      const owner = state.board[k];
      const [, y] = coords(k);

      // How far this pawn has come, counted from its own starting row.
      const advanced = owner === 0 ? y : state.config.size - 1 - y;

      const worth = 10 + advanced * advanced * 3;
      score += owner === actorId ? worth : -worth;
    }
    return score;
  },
};

export default hexapawn;
