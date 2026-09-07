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
/checkered
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

## Naming

The engine is **Checkered**. The games it hosts are **Territory**,
**Checkers**, and **Chess**.

Keeping those names distinct is deliberate, not decoration. The engine
does not know what game it is hosting — guard tests read `board.js` and
`main.js` and fail the build if either mentions a game's vocabulary. If
the engine shared a name with one of its rulesets, every conversation
about "Checkered" would need a clarifier about which layer was meant,
and the layer that is hardest to keep honest is exactly the one that
would blur.

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
- **2026-09-02 · rulesets/territory.js, main.js, styles.css** — The
  opening ground is now scattered in `createInitialState`, before anyone
  places a camp, so players can see the neutral stacks and loose armory
  and choose a start with them in mind. Three consequences:

  - The scatter can no longer anchor on the camps, because there aren't
    any yet. It spreads around the origin, with `scatterClear` keeping
    the middle open, and scales by player count as before.
  - `canPlace` measured spacing against *every* occupied square, which
    with neutrals present would have fenced players away from exactly
    the ground they are competing for. Spacing is now measured against
    `s.starts` only — camps keep their distance from each other, but a
    camp may sit beside a neutral. A start still cannot be pitched on
    top of one.
  - `createInitialState` has nowhere to write a log entry, so the
    scatter note is held on the state as `openingNote` and pushed by the
    first action taken. Tested that it appears exactly once.

  The placement window widened to take in `scatterRadius`, so the whole
  scattered field is visible while choosing. Neutral chips were
  desaturated *and* dimmed, which made them nearly invisible now that
  they are the first thing a player reads; they keep the desaturation
  and lose the dimming. Picker heading is one colour. Suite at 235.
- **2026-09-02 · board.js, styles.css, main.js, rulesets/index.js** —
  Visual and editor work.

  Counted pieces are drawn as a physical column again: `board.js` emits
  one `<i class="chip">` per unit counted, tagged with the counter's
  `kind`, and elides past `COLUMN_CAP` with the break marked so height
  isn't read as an exact figure. This stays generic — it is driven by
  the `counters` a ruleset already supplies, so chess and checkers,
  which count nothing, keep their glyphs untouched.

  Filled buttons now brighten on hover rather than darkening; darkening
  read as disabled. The guard test was updated to assert the new intent
  rather than deleted.

  Both editors now open showing something real. The ruleset registry
  carries a `sourceUrl` per game, so the code editor fetches and shows
  the actual file, and can either apply an edit to the running game or
  register it as a separate ruleset. Live application is refused when
  `UI.online` is set — rules pin at the start of a network match. The
  styling editor opens with a starter sheet listing the variables and
  selectors actually in use, with values read off the live page rather
  than written into the file, plus a button to load the whole shipped
  stylesheet for anything the starter doesn't mention.

  Note: both editors fetch their own source, so the page must be served
  over http. Opened from disk they show an explanatory message instead
  of failing silently. Suite at 229 tests.
- **2026-09-01 · ai-api.js, engine.js, rulesets, main.js** — The AI
  layer. `src/ai-api.js` holds the contract, a generic evaluator, a
  greedy opponent, and an AI registry mirroring the ruleset one. Two
  contract additions were needed: `Engine.preview()` applies an action
  to a copy without touching history, log, or listeners; and
  `occupiedCells()` joins the ruleset contract, because `describeCell`
  only answers about coordinates you already hold and an infinite board
  gives no way to guess which ones matter.

  Every AI move goes through `applyAction`, so a game against a bot is
  describable by the same five things as any other and replays exactly;
  there is a test per ruleset proving it.

  Measured against random play: checkers 20-0, chess 20-0, Territory 6-0
  on ground. Four findings worth keeping:

  1. The first version *lost every checkers game to random*. The denial
     term counted opponent mobility, and with compulsory captures the
     cheapest way to shorten the opponent's reply list is to hang a
     piece. Mobility is now excluded from denial.
  2. Still 17-23 after that fix, because it could not see a piece taken
     straight back. A one-ply reply check on a shortlist took it to
     20-0. It still cannot see a two-move trap; that is the honest
     ceiling of a greedy player.
  3. Territory hung outright. Forge and burn are exactly reversible at
     zero cost, so the AI oscillated forever. Cycle detection needed
     `positionHash()`, which strips `rngState` and `actionCount` —
     `hashState` includes them, so identical positions never matched and
     the check silently did nothing. **Design note for Bob: forge and
     burn currently compose to a free no-op. Harmless between people,
     but any automated player finds it.**
  4. Territory reached 26 seconds a turn. Profiling (not guessing —
     the first guess was wrong) showed `legalActions` at ~0.4ms
     dominating, re-enumerated per candidate. A work budget
     (`MAX_CANDIDATES`, `REPLY_CEILING`, `SAFETY_SHORTLIST`) brought the
     slowest turn to 1.7s.

  Territory also gained its own `evaluate()`. The generic scorer counts
  every counter alike, so an armory chip weighed the same as a unit
  chip, and forging turned unvalued moves into valued armory — the bot
  spent whole turns forging. That is what the contract's escape hatch is
  for: a game whose resources aren't interchangeable has to say so.

  UI: each seat in the picker is a person or a bot (seat two defaults to
  a bot, so a lone visitor has an opponent), the bot's turn is stepped
  one action at a time with a pause between so a long Territory turn
  renders as decisions rather than a freeze, the board locks while it
  plays but still allows inspection, and its weights are tunable in
  settings. A bot that throws hands its seat back rather than stranding
  the game. Suite at 224 tests.
- **2026-09-01 · main.js, styles.css** — Opening placement now uses its
  own highlight (`hl-place`) instead of borrowing the move-target one.
  A placement field can cover every square on screen, and the dashed
  border that reads well on a handful of targets became noise at that
  scale; the quiet wash lets the excluded ground around a rival's camp
  show through as a hole instead.
- **2026-09-01 · board.js, main.js, styles.css** — Four fixes, none of
  which the suite had covered; all four now have tests.
  Vertical panning was inverted: `panBy` subtracted on both axes, but
  board y grows upward while screen y grows downward, so dragging down
  sent the ground up.
  Pooled cells weren't fully wiped when they emptied, so a recycled
  element kept the previous occupant's `data-label` (captions on bare
  ground, and stale ones bleeding across a game switch). The same gap
  left `slot.dataset.sig` behind, which would have made an identical
  piece returning to a vacated square never render at all — latent, and
  now covered.
  `button.primary` had brass text painted onto its brass fill by the
  generic hover rule, erasing the label; filled buttons now darken the
  fill and keep ink text.
  Territory's opening placement only highlighted for the first player.
  `canPlace` had always enforced camp spacing, but `commit()` parked the
  selection on the square just placed, and placement highlights only
  render when nothing is selected. A placement has no origin, so it is
  no longer treated as the start of a chain. The second player now sees
  the same field with a hole in it where the spacing rule forbids them.
- **2026-09-01 · index.html, main.js, styles.css** — The wordmark now
  reads "Checkered <Game>", taking the second half from the registry
  entry rather than from anything the engine knows. Clicking it (or
  hitting Enter on it) offers to leave the game and return to the
  picker; a finished game skips the prompt, since nothing is at stake.
  New tagline. Fixed a drag-selection bug: counters and labels are real
  text nodes, so panning swept a selection across every square it
  crossed — the board now sets `user-select: none`.
  Two bugs surfaced while testing this. `modal.el` was resolved only in
  `boot()`, so any dialog opened before boot died on a null and showed a
  blank page; it now resolves lazily and re-resolves if detached. And
  `styles.css` hardcoded `.piece.light` / `.piece.dark` to fixed greys,
  which silently overrode the seat colors a ruleset passes down through
  `describeCell` — the stylesheet was quietly ignoring the contract.
  `.piece` now takes `var(--unit-color)` and the light/dark classes only
  decide which way the text shadow falls. Guard test added. Suite at 187.
- **2026-08-31 · project-wide** — Renamed the engine from Boardworks to
  **Checkered**: directory, `package.json`, page title, wordmark, and
  the theme's localStorage key. The Territory ruleset keeps its name, so
  the engine and its rulesets stay nameable apart (see Naming above).
  `theme.js` reads the old key once and migrates it, so custom CSS
  written before the rename isn't silently lost; the migration and the
  storage-unavailable fallback are both tested. Suite at 179 tests.
