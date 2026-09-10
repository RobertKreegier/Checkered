# Checkered

A generic engine for games played on a grid. It hosts three rulesets —
Territory, Checkers, and Chess — and the whole design rests on the engine
not knowing which one it is running.

**Read `ARCHITECTURE.md` before making changes.** It holds the layer
model, the ruleset contract, the process checklist, and a changelog
explaining why things are the way they are. This file is only the short
version.

## The rule that matters most

The engine, the renderer, and the UI must never learn any game's
vocabulary. `src/board.js` and `src/main.js` ask the ruleset what actions
exist (`legalActions`), where they point (`describeAction`), and what to
draw (`describeCell`) — they never branch on which game is loaded.

This is enforced, not just documented: guard tests in
`test/integration.test.js` and `test/ui.test.js` read those two files as
source and fail the build if either mentions a game term in code.
Comments about the design are fine; branching on it is not.

If you find yourself wanting to special-case a game in a shared layer,
that is a signal the contract is the wrong shape. **Fix the contract, not
the caller.** Every abstraction in the contract exists because a test
caught a leak — `describeAction()` and the neutral `colors.primary` /
`colors.accent` seat fields both came from exactly that.

## Core invariant

A game must be fully describable by
`(ruleset, config, seed, players, actions)`.

Anything that can't be replayed from those five things is a bug. This is
what makes undo, serialization, and the multiplayer cross-validation
scheme work. Two consequences that have bitten before:

- Never introduce state through a side channel. Players and starting
  positions are engine options passed into `createInitialState`, not
  setter calls, because replay can't see a setter.
- Never use `Math.random`, `Date.now`, or the DOM inside a ruleset. Use
  the seeded rng the engine hands you. A conformance test scans for this.

## Before calling anything done

1. `npm test` — the whole suite, currently 179 tests, must pass.
2. New behaviour has a test. Tests are written alongside features, not
   after.
3. A new ruleset goes in `rulesets/index.js`. The registry is the single
   list of games; conformance reads from it, so registering is what gets
   a game tested at all.
4. If the contract changed, update `ARCHITECTURE.md` — both the contract
   section and the changelog, with the reasoning.

If a conformance test needs a game-specific special case to pass, the
contract is wrong. Fix the contract, not the test.

## When a test disagrees with the code

Check which one is wrong before changing either. Several times the test
expectation was the error and the implementation was right; several other
times a failing test exposed a real design flaw. Don't bend an
implementation to satisfy an assertion you haven't verified.

## Layout

```
/root                 EVERYTHING THE WEBSITE SERVES. Netlify's publish
                      directory is this folder, not the repo root.
  index.html          shell: loads modules, mounts board + panel
  /src
    engine.js         turn order, undo, serialize, cross-validation
    ruleset-api.js    the contract, and validateRuleset()
    board.js          virtualized DOM renderer, pooling, pan/zoom
    main.js           generic interaction loop, panel, modals
    ai-api.js         AI contract + the greedy opponent
    ai-search.js      alpha-beta opponent
    match.js          two machines playing one game, over any transport
    saves.js          autosave, named slots, export/import
    codec.js          base64url shared by match and saves
    ladder.js         bot-vs-bot measurement
    theme.js          per-player CSS, localStorage only
    styles.css        the default look; every rule overridable
    rng.js hash.js    seeded randomness; canonical hashing
  /rulesets
    index.js          THE REGISTRY
    tictactoe.js hexapawn.js   the two worked examples — read these first
    territory.js checkers.js chess.js
/test                 reaches in with ../root/src/... — conformance.test.js
                      runs the same battery on every registered ruleset,
                      and that one is the centerpiece
/tools                benchmarks, run by hand from the repo root
```

Tests and tools live OUTSIDE `/root` so the published site carries only
what it needs. Anything under `/root` is publicly readable once
deployed, which is required: the ruleset code editor and the styling
editor both fetch their own source at runtime.

## Style

Plain, readable JS, no build step and no framework. Comments explain
*why*, not what. The renderer is DOM rather than canvas on purpose:
canvas pixels can't be restyled by a player's own stylesheet, and
per-player theming is a first-class goal — don't "optimize" that away.

## The AI layer

`src/ai-api.js` is the AI contract plus a greedy opponent. Same rule as
everywhere else: it must not learn any game's vocabulary, and a guard
test enforces it. An AI gets legal actions, a preview function, an
evaluator, and a seeded rng — never Math.random, so a game against a bot
replays like any other.

Two things to know before changing it:

- **Cycle detection uses `positionHash()`, not `hashState()`.** The
  latter includes `rngState` and `actionCount`, which change every
  action, so identical positions never match. Territory's forge and burn
  are exactly reversible, and without this the bot loops forever.
- **The work budget is load-bearing.** `MAX_CANDIDATES`,
  `REPLY_CEILING`, and `SAFETY_SHORTLIST` exist because Territory
  reached 26 seconds a turn without them. Raise them and measure.

## The two opponents

`greedyAi` (ai-api.js) looks one move ahead plus a reply check.
`searchAi` (ai-search.js) does alpha-beta with iterative deepening and
is much stronger where a turn is a single move.

`searchAi` **delegates Territory to greedy on purpose.** A Territory
turn is ~100 actions, so one ply of search means enumerating a whole
turn; measured at 3s/turn and no stronger. Don't "fix" this by raising
the budget. Making Territory's bot better means a richer `evaluate()`
or planning at the level of turns, not more depth.

Use `src/ladder.js` to check any change to either bot. Claims about
strength should come with a score, not an impression — the first greedy
player lost every game of checkers to random play while looking fine.

## Not yet built

- `src/net.js` — relay client and the desync comparison UI.
- `/server/relay.js` — a dumb move relay that knows no rules.

**Never eval ruleset or AI code on a server.** Client-side eval of
pasted code is an accepted, deliberate risk at userscript-level trust;
server-side eval is the hard line.
