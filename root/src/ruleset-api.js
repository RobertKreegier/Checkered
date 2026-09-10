/* ruleset-api.js — the contract every game is written against.
 *
 * A ruleset is a plain object (usually the default export of one file)
 * describing a game that plays out on a grid of cells. The engine knows
 * nothing about camps, knights, kings or kropki dots — it only knows the
 * functions below. Everything game-specific lives behind them.
 *
 * A ruleset must be PURE with respect to the outside world:
 *   - no DOM, no window, no fetch
 *   - no Math.random() — use state.rng via the helpers the engine passes
 *   - no wall-clock time
 * Break any of those and undo, replay, and multiplayer cross-validation
 * all quietly stop working.
 *
 * ---------------------------------------------------------------------
 * REQUIRED
 * ---------------------------------------------------------------------
 *
 * id            string   stable identifier, e.g. "territory"
 * name          string   display name
 * version       string   bump when behavior changes
 * config        object   tunable numbers/flags (the old CFG)
 * configSpec    array    [[groupTitle, [[key, label, "num"|"bool"|"text"], ...]], ...]
 *                        drives the settings UI; keys must exist in config
 *
 * createInitialState(config, rng, players) -> state
 *   Fresh game. `state` must be plain JSON-serializable data. The engine
 *   adds bookkeeping fields (rngState, actionCount) itself.
 *
 *   `players` is whatever the table agreed on — for Territory, name and
 *   colors per seat. It arrives here rather than through a separate
 *   "seat the table" call on purpose: a game must be rebuildable from
 *   (ruleset, config, seed, players, actions) and nothing else, or
 *   replay and deserialization quietly lose the roster.
 *
 * legalActions(state, actorId, scope) -> action[]
 *   Every action that actor may take right now, as plain objects with a
 *   `type` field. Shape beyond that is the ruleset's business. This is
 *   the single source of truth for legality: the UI highlights from it,
 *   the AI chooses from it, and the engine validates against it.
 *
 *   `scope` is an optional hint, e.g. {from:{x,y}} or {type:"move"}, that
 *   a ruleset MAY use to return a narrower list. It is only ever a
 *   performance aid — a ruleset is free to ignore it and return
 *   everything. Games where the full list is combinatorially large
 *   (Territory, with a chip split and a spend count per target) should
 *   honour it so the UI isn't enumerating thousands of actions a frame.
 *
 * applyAction(state, action, rng) -> logEntry[] | void
 *   Mutate state to carry out an action the ruleset already declared
 *   legal. Return log lines (strings, or {text, actorId}) to record.
 *   Phase and turn advancement happen here too — the engine does not
 *   drive them, since only the ruleset knows what a "turn" means.
 *
 * isTerminal(state) -> null | {winnerId | null, reason}
 *   Null while the game is live. A result object ends it; winnerId null
 *   means a draw.
 *
 * describeCell(state, x, y) -> null | cellView
 *   What the renderer should draw at a coordinate, as data — never DOM.
 *   Null for empty ground. Fields, all optional except where noted:
 *     ownerId      which actor it belongs to, or null for nobody's
 *     label        short caption shown at larger zooms, e.g. "CAMP"
 *     classes      string[] appended to the piece element, so a
 *                  stylesheet (including a player's own CSS) can target
 *                  it — this is how a game gets its look
 *     glyph        text drawn in the piece, e.g. a chess character
 *     counters     [{kind, value}] small numbers drawn on the cell;
 *                  `kind` becomes a class
 *     colors       {name: cssColor} set as CSS custom properties on the
 *                  cell, e.g. {'unit-color': '#E2574C'}
 *     stackHeight  a hint for depth/thickness, default 1
 *
 *   Keep this generic. The renderer must never learn what a particular
 *   field MEANS — if it needs to know, the field is in the wrong shape.
 *
 * ---------------------------------------------------------------------
 * OPTIONAL
 * ---------------------------------------------------------------------
 *
 * describeAction(state, action) -> {from, to, label, group}
 *   How an action relates to the board, so a generic UI can offer it
 *   without understanding the game. `from` and `to` are {x,y} or null;
 *   `label` is short text for a button; `group` buckets actions that
 *   share a target square so the UI can ask "which of these?" when a
 *   square affords more than one (a chess promotion, a Territory chip
 *   split). Omit it and the UI falls back to listing actions as buttons.
 *
 * isLegal(state, action, actorId) -> boolean
 *   A cheap direct check, so the engine need not build and scan the full
 *   action list just to validate one action. Must agree exactly with
 *   legalActions() — if the two ever disagree, legalActions() wins and
 *   the disagreement is a bug. Omit it and the engine falls back to
 *   scanning.
 *
 * rulesText     string   markdown-ish rules shown in-app
 * describeActor(state, id) -> {name, colors, status}   for the roster UI
 * summarize(state) -> object    small status blob for the side panel
 * bounds(state) -> {x0,y0,x1,y1} | null
 *   Finite boards return their extent so the renderer can fit and refuse
 *   to scroll into nothing. Omit (or return null) for an infinite board.
 */

const REQUIRED_FUNCTIONS = [
  'createInitialState',
  'legalActions',
  'applyAction',
  'isTerminal',
  'describeCell',
];

const REQUIRED_FIELDS = ['id', 'name', 'version', 'config', 'configSpec'];

/**
 * Check a ruleset before it is allowed to run. Returns a list of problems;
 * empty means it's usable. This is a shape check, not a safety boundary —
 * a hostile ruleset passes it easily. Its job is to give someone editing
 * a ruleset a clear error instead of a mystery crash three moves later.
 */
export function validateRuleset(rs) {
  const problems = [];
  if (!rs || typeof rs !== 'object') return ['Ruleset is not an object.'];

  for (const f of REQUIRED_FIELDS) {
    if (rs[f] === undefined) problems.push(`Missing required field: ${f}`);
  }
  for (const fn of REQUIRED_FUNCTIONS) {
    if (typeof rs[fn] !== 'function') problems.push(`Missing required function: ${fn}()`);
  }
  if (rs.config && typeof rs.config !== 'object') {
    problems.push('config must be an object.');
  }
  if (rs.configSpec !== undefined) {
    if (!Array.isArray(rs.configSpec)) {
      problems.push('configSpec must be an array of [groupTitle, rows].');
    } else {
      for (const group of rs.configSpec) {
        if (!Array.isArray(group) || group.length !== 2) {
          problems.push('Each configSpec group must be [title, rows].');
          continue;
        }
        for (const row of group[1] || []) {
          const [key, , type] = row;
          if (rs.config && !(key in rs.config)) {
            problems.push(`configSpec references unknown config key: ${key}`);
          }
          if (type !== 'num' && type !== 'bool' && type !== 'text') {
            problems.push(`configSpec row ${key} has unknown type: ${type}`);
          }
        }
      }
    }
  }
  return problems;
}

/** Compare two actions for equality — used to validate a claimed action. */
export function actionsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.type !== b.type) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
