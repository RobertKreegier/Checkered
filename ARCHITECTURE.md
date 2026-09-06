# Territory Engine — Architecture & Process

This is a living reference for the rewrite. It exists so that every change —
engine, ruleset, AI, rendering, multiplayer — has a clear home, a clear
contract, and a clear test before it's considered done. Update the
Changelog at the bottom as things move.

## The vision

This is no longer "Territory, the game." It's a **generic board game
engine** for anything that plays out on a grid of cells — Territory, chess,
checkers, and whatever else someone invents. A player opens the page,
picks a ruleset from a list (or pastes/writes their own), and plays.

- A ruleset is plain, readable, **editable JS**. Territory ships as one
  ruleset; chess and checkers can ship as reference rulesets others copy
  and modify.
- Players can see the ruleset's code in an editable panel, with a toggle
  to hide it.
- **Single-player**: the ruleset can be edited live, mid-game, since
  there's no opponent to desync from.
- **Two-player online**: the ruleset is locked once the match starts, and
  the two clients cross-check each other's moves (see Multiplayer below).
- Each player can also theme their *own* view with custom CSS — never
  shared with the opponent.

This generalizes cleanly from what we'd already scoped: `rules.js` becomes
one ruleset among many rather than "the" rules; the AI contract and the
process checklist barely change shape at all.

## File layout

```
/territory-engine
  index.html              shell: ruleset picker, board mount, editor panels
  /src
    engine.js              generic game loop: turn order, undo, serialize,
                            cross-validation — knows nothing about any one game
    board.js                DOM/SVG board renderer: viewport culling, pan/zoom,
                            cell/piece rendering driven entirely by ruleset data
    ruleset-api.js           the contract every ruleset is written against
    ai-api.js                the contract AI scripts are written against
    net.js                   relay client: send/receive moves, replay-and-compare
    editor.js                code + CSS editor panels, live-eval with error boundary
    theme.js                 per-player CSS: custom-property panel + raw CSS escape hatch
    territory.js             Territory, as a ruleset
    chess.js                 reference ruleset — full rules, FEN, perft-verified
    checkers.js               reference ruleset — English draughts
  /scripts
    /ai                       user-authored AI scripts (plain .js)
  /server
    relay.js                  dumb move relay only — no rules knowledge, no validation
  /test
    engine.test.js            engine core against a toy ruleset
    ruleset-territory.test.js
    ruleset-checkers.test.js
    ruleset-chess.test.js     includes perft node counts
    conformance.test.js       the SAME tests run against every ruleset
    selfplay.test.js          random-move fuzzing
    integration.test.js       jsdom, exercises board.js rendering
    ui.test.js                jsdom, drives the real click-to-move loop
  ARCHITECTURE.md            this file
```

**Dev workflow note:** ES modules don't load over `file://` in most
browsers, so local dev needs a static server (`npx serve`,
`python3 -m http.server`, etc.).

## Rendering: DOM/SVG, not canvas

Territory's current canvas renderer is great for infinite pan/zoom but is
invisible to CSS — you can't theme a canvas chip with a stylesheet. Since
per-player CSS theming is a real goal, `board.js` renders **real DOM/SVG
elements**, virtualized: only cells inside the viewport get mounted,
reusing the same culling math the current `draw()` already does by hand.
Pieces are DOM elements too, so a ruleset's default look and a player's
custom CSS both just... work, the normal way CSS works.

A ruleset can still opt into a `<canvas>` overlay for effects that don't
suit DOM (Territory's phase glow, say) — `board.js` should support that as
an addition, not force every ruleset into one rendering mode.

## Engine / ruleset split

`engine.js` is generic and ignorant of any specific game: it owns turn
order, phase transitions in the abstract, undo/snapshot, serialization,
and the relay/cross-validation flow. It knows nothing about "camps" or
"knights" — only that a ruleset defines cells, legal actions, and a way to
apply them.

A **ruleset** (`ruleset-api.js` contract) exposes:

- `createInitialState(config)` → board + any game-specific fields
- `legalActions(state, actorId)` → list of actions the mover could take
  right now (production targets, move targets, whatever the game calls
  for — shape is ruleset-defined, opaque to `engine.js`)
- `applyAction(state, action)` → mutates state, returns log entries
- `isTerminal(state)` → boolean/winner
- `describeCell(cell)` → data `board.js` uses to render, ruleset-owned
- `serialize(state)` / `deserialize(json)`

This is Territory's `legalTargets`/`produce`/`moveTokens`/`finishTurn`
etc., generalized just enough that chess or checkers can implement the
same five-function contract instead of a Territory-shaped one.

## AI script contract (`ai-api.js`)

Unchanged in spirit from before — an AI script only calls a ruleset's
`legalActions`/`applyAction` through the engine, same path a human takes:

```js
export default {
  name: "Greedy Territory Bot",
  author: "you",
  version: "1",
  chooseAction(state, actorId) { /* -> action | null (null = pass/end phase) */ },
};
```

Since it's engine-mediated rather than ruleset-specific, the same AI
contract works across every ruleset — a bot author targets the contract,
not any one game.

## Multiplayer: dumb relay + replay cross-validation

The server (`relay.js`) is intentionally not a rules authority. It never
evaluates a move — it only timestamps and forwards `{action, resultingState}`
packets between the two clients in a match. This matches the trust model:
friends sharing a game, not anti-cheat against strangers.

**Cross-validation, client-side, on every incoming move:**

1. Client A sends `{action, resultingStateHash}` after applying a move
   locally with its own copy of the (locked) ruleset.
2. Client B receives it, independently calls its own
   `ruleset.applyAction(itsOwnCopyOfState, action)`, and compares the
   resulting hash to what A sent.
3. **Match** → accept, move on.
4. **Mismatch** → pause the match for both players and show the
   divergence in full: the action in question, both clients' resulting
   states side by side, and a plain-language "these disagree" flag.
   Friends-only trust model, not anti-cheat — transparency over
   obscurity. Nobody's state is hidden from either player at that point,
   since the point is to make it obvious something's wrong and let the
   two of them sort out why (stale ruleset edit, bug, etc.), not to
   quietly police one side.

This means: the ruleset text itself should be hashed/pinned at match
start (same versioning idea as AI scripts), each client keeps *two* copies
of state during a match — its own authoritative one and nothing from the
network is trusted without replay — and `engine.js`'s relay layer needs a
clear "desynced, game paused" state distinct from normal play.

**What this buys:** no server-side rules engine to keep in sync with the
client rulesets, no server trust required, and cheating-by-ruleset-edit is
caught by the *other player's* engine rather than by the server. What it
doesn't buy: protection against two colluding clients, or a client that
lies about its own hash — not a goal here, given the friends-only trust
model.

## Security posture

- **Client-side eval of a pasted ruleset or AI script** is the same risk
  class as installing a userscript from someone you trust — contained to
  that tab, that origin. Acceptable for the friends-and-tinkerers use
  case this is built for.
- **Never eval ruleset/AI code on a server.** If a server exists, its job
  is relaying `{action, hash}` packets — nothing it receives is ever
  executed. This is the one hard line, independent of how much the
  client-side trust model relaxes.
- **Live-editing in single player needs an error boundary.** A syntax
  error or runtime exception in a hand-edited ruleset must not white-
  screen the page — `editor.js` wraps eval in `try/catch` and surfaces
  the error in the editor panel itself.
- If this ever opens up to strangers sharing scripts publicly, add a
  "review before run" step instead of auto-running pasted code. Not
  needed for the current friends-only scope — noted so it isn't
  forgotten if scope changes.

## Per-player CSS theming

Two layers, both stored in `localStorage`, both local to that player only
— never transmitted to the opponent:

1. **Friendly panel** exposing the existing CSS custom properties
   (`--brass`, `--felt`, etc.) for quick recoloring without touching raw
   CSS.
2. **Raw CSS textarea** as an advanced escape hatch, for anyone who wants
   to go further than the custom-property panel allows.

Both need a "reset to default" control, since a bad raw-CSS edit could
otherwise strand someone in a broken view of their own board with no way
back except clearing storage manually.

## Conformance: the bar a new ruleset must clear

`conformance.test.js` runs one battery against every registered ruleset.
It is the file that justifies the engine/ruleset split, and the first
place to look when adding a game. Every ruleset must:

- pass `validateRuleset()`
- offer legal actions to whoever is on turn, with `isLegal()` agreeing
  with `legalActions()` on every one
- leave state untouched when an action is refused
- return to an exact prior fingerprint on undo
- produce the same game from the same seed
- replay from (config, seed, players, actions) to an identical fingerprint
- round-trip through serialize/deserialize
- offer nothing once the game is over
- return JSON-serializable data from `describeCell()` — never DOM
- accept an honest move and reject a tampered one under cross-validation
- contain no `document.`, `window.`, `Math.random`, or `Date.now`

**If a conformance test needs a special case for one game, the contract
is leaking game-specific assumptions — fix the contract, not the test.**

## What the second and third rulesets taught us

Adding chess and checkers found real design problems that Territory alone
never would have, which was the point of doing it before building the UI:

- **Not every action is a from/to pair.** A checkers multi-jump is one
  action carrying a whole path. An engine that assumed from/to would have
  needed a "mid-jump" phase, and undo would have rewound half a capture.
- **Legality can depend on the position after the move.** Chess pins mean
  generation is filter-then-offer, not enumerate-and-trust. The contract
  already allowed this; it's worth knowing it's exercised.
- **Starting positions belong in config.** Chess needed arbitrary FEN
  positions for perft. That went into `config.fen` rather than an extra
  argument, for the same reason players became an Engine option: a game
  must be fully described by (ruleset, config, seed, players, actions).
- **`configSpec` needed a `text` type**, which only surfaced once a
  ruleset had a non-numeric setting to expose.

## The generic UI

`main.js` must work for any registered ruleset without knowing which one
it is. It never asks "is this chess?" — it asks the ruleset what actions
exist (`legalActions`), where they point (`describeAction`), and what to
draw (`describeCell`). One interaction model falls out and covers all
three games:

- click a piece → select it, highlight where its actions land
- click a target → one action there, do it; several (a chess promotion, a
  Territory chip split), ask which
- actions with no target square (end turn, trades) become panel buttons

Two guard tests enforce the separation by reading the source: `board.js`
and `main.js` must not mention any game's vocabulary in code. Comments
about the design are fine; branching on it is not.

**Seats are `{name, colors:{primary, accent}}`.** The color names are
deliberately generic — a ruleset decides what they mean, so the UI never
learns a game's vocabulary. (This came out of a guard test catching
`main.js` reading `player.armory`.)

## Process checklist for any change

1. **Name the layer.** Engine, ruleset, AI contract, board/render, net/
   relay, editor, or theme — pick one. Most changes should touch exactly
   one.
2. **Engine and ruleset changes get a test first.** Pure Node tests
   (`engine.test.js`, `ruleset-*.test.js`) before touching the
   implementation.
3. **Render-only changes shouldn't touch `engine.js` or any ruleset.** If
   they do, that's a sign the layers leaked — stop and reconsider.
4. **New tunable numbers go in a ruleset's own config/spec**, never
   hardcoded inline, same pattern as Territory's existing `CFG`/`CFG_SPEC`.
5. **New rules get a paragraph in that ruleset's in-app rules text**, same
   turn as the code — so the UI and actual behavior can't drift.
6. **Run the full test suite** — engine, the affected ruleset(s), and the
   jsdom integration test — before calling a change done.
7. **If the change touches state shape, randomness, or the action log,**
   re-check that replay cross-validation still produces identical hashes
   for identical inputs — this is the thing most likely to break quietly.
8. **Log it** in the Changelog below: date, one line, which layer.

## Open questions / deferred

- Seeded RNG for anything with randomness (Territory's neutral-stack
  scatter, move-spill placement) — needs to be part of state, not
  `Math.random()`, both for undo-replay and for cross-validation to work
  at all. Should land early in the `engine.js`/`ruleset-api.js` work,
  not deferred like the items below.
- Sandboxing for *stranger-shared* scripts (Worker boundary or a
  restricted DSL) — deferred per friends-only scope above.
- Hash algorithm for state comparison — anything collision-resistant
  enough for this purpose is fine; not a cryptographic security boundary,
  just a "did we compute the same thing" check.

## Changelog

- **2026-08-28 · engine, ruleset** — Core layer built and tested. `rng.js`
  (seeded, position stored in state), `hash.js` (canonical JSON,
  fingerprints, first-difference reporting), `ruleset-api.js` (contract +
  validator), `engine.js` (single mutation chokepoint, action validation,
  undo/undoTo, serialize/replay, `verifyRemoteAction` cross-validation),
  and Territory ported to the contract as `rulesets/territory.js`.
  58 Node tests passing, no DOM anywhere.
- **2026-08-28 · engine** — Design fix found by a failing replay test:
  players were being seated through a side-channel `setPlayers()` call
  that replay and deserialization couldn't see, so a rebuilt game had an
  empty roster. Players are now an Engine option passed into
  `createInitialState`, keeping the rule that a game is fully described by
  (ruleset, config, seed, players, actions).
- **2026-08-28 · rulesets** — Checkers and chess added as reference
  rulesets, to prove the engine isn't Territory in disguise. Chess is
  verified by perft against published node counts (opening position to
  depth 4 = 197,281; Kiwipete to depth 3 = 97,862), which exercises pins,
  castling through check, en passant, and promotion. Added
  `conformance.test.js`, one battery run against all three games. Suite
  now 146 tests.
- **2026-08-28 · rulesets, engine** — Rules text ported into all three
  rulesets (Territory's from the original build), so the process rule
  that rules ship with code is actually satisfied. Added
  `rulesets/index.js` as the single registry; `conformance.test.js` now
  reads from it, so a newly added game is covered automatically rather
  than silently untested.
- **2026-08-28 · board, main, theme** — The UI layer: `board.js`
  (virtualized DOM renderer with element pooling), `main.js` (generic
  interaction loop), `theme.js` + the CSS editor, `styles.css`, and
  `index.html`. Added `describeAction()` to the contract — the bridge
  that lets a generic UI offer a game's actions without understanding
  them. Two source-reading guard tests now fail the build if the
  renderer or the UI learns a game's vocabulary; one of them caught
  `main.js` reading `player.armory`, which is why seats now carry
  neutral `colors.primary` / `colors.accent`. Suite at 174 tests.
