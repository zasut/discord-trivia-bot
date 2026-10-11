# AGENTS.md

Guide for coding agents working in this repo. Human setup and run steps (Developer Portal,
`.env`, inviting the bot, loading questions) are in [README.md](README.md). This file
covers how the code works today and how to change it safely. The full design and the build
plan are in [DESIGN.md](DESIGN.md).

## Project

A Discord trivia bot built on **discord.js v14** as a **gateway bot**. It keeps a websocket
open to Discord, so there is no HTTP server, tunnel or public URL. The playable game is
**"Are You Smarter Than a Fifth Grader"**, solo: `/start` takes the player through a private
(ephemeral) setup, then posts a public board of grade + subject tiles. They climb from
1st to 5th grade, answering multiple-choice or typed questions against a timer. Every game
and guess is saved to a local SQLite database. Trivia night (teams) is designed but not
built yet; see Roadmap.

- Node.js ≥ 22.13 (for the built-in `node:sqlite`), ES modules (`"type": "module"`), plain
  JavaScript.
- Dependencies: `discord.js`, `dotenv`. Dev: `nodemon`. The database is `node:sqlite` and
  the tests use `node:test`, so neither adds a dependency.
- No build step, linter or formatter config. Match the style of the surrounding code
  (2-space indent, single quotes, semicolons, trailing commas).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies. |
| `npm test` | Unit tests (`node --test`, files in `test/`) followed by the smoke test. **This is how you verify a change.** Needs no credentials. |
| `node scripts/smoke.js` | Just the offline end-to-end test, which uses a fake Discord client. |
| `npm start` / `npm run dev` | Run the bot (`node app.js` / nodemon). Logs in with the real token from `.env`. |
| `npm run register` | Bulk-overwrites the app's **global** slash commands on Discord with `commands.js`. |
| `npm run import [-- path]` | Validates a question CSV and loads it into the database (default `data/questions.csv`). |

`npm start`, `npm run dev`, `npm run register` and `npm run import` use the user's live
Discord app or their real database. Agents can't click buttons in Discord, so leave live
runs, command registration and real imports to the user unless they ask. To test the import
script, point it at a scratch file and set `TRIVIA_DB_PATH` to a scratch database.

## Rules

- **`.env` is off-limits.** It holds the live bot token. Never read, open, print, copy or
  edit it, and never run anything that would print its contents. If you need a value from
  it, ask the user. If you notice anything reading or writing `.env` unexpectedly (a
  script, a tool, a command), report it. Only `.env.sample` (placeholders) is tracked, and
  `.env` must stay gitignored.
- **Tests are mandatory.** Run `npm test` after any code change and report the result. When
  you add a screen, button or command, extend `scripts/smoke.js` to drive it, and cover pure
  logic and database queries with unit tests in `test/`.
- **`data/` is off-limits too.** It holds the user's private question bank
  (`data/questions.csv`) and real stats (`data/trivia.db`). Never read, modify or import from
  it unless asked. Tests use `:memory:` or a temp directory.
- **No commits unless asked.** Don't `git commit` or `git push` unless the user explicitly
  asks. Working through DESIGN.md's build plan counts as asking for one commit per phase,
  plus a separate `Fix ...` commit for any bug found in code that is already committed.
- **Commit messages** are one short line in the imperative, e.g.
  `Add solo board game with difficulties`. No body, and no AI attribution (no
  `Co-Authored-By` trailer, no "Generated with" footer).
- **Ask before adding npm dependencies.** The DESIGN.md plan needs none: it uses Node
  built-ins (`node:sqlite`, `node:test`).
- **Never put anything in a custom_id that reveals an answer.** Players can read custom_ids
  in their Discord client.
- **Keep this file in sync.** When you change the custom_id scheme, slash commands, session
  shape, tunables or file layout, update the matching section here in the same change.
  When a DESIGN.md phase lands, tick it there too.

## Files

| File | Role |
|---|---|
| `app.js` | Thin shell. Opens the database (seeding the sample questions if it is empty), creates the discord.js `Client` (intent `Guilds` only), logs in and forwards every `InteractionCreate` to `handleInteraction`. If a handler throws, it sends the user an ephemeral error notice. |
| `flow.js` | `handleInteraction`, the single router for commands, buttons and modal submits, plus the ephemeral `/start` setup screens and the `/stats` command. |
| `solo.js` | Solo runs: the board, questions, answers, lives, timers and the end-of-run summary. |
| `board.js` | Building the Fifth Grader board from the question bank, the climb rule, and rendering it as button rows. |
| `ui.js` | Payload builders: `button`, `row`, question / result text, the answer modal, `publicPayload`, `displayName`. Pure. |
| `messages.js` | `sendMessage` / `editMessage` / `deleteMessage` by channel id. Mentions never ping. |
| `answers.js` | Typed-answer normalisation and checking. Pure. |
| `cheats.js` | The solo cheats: the cheat list, `cheatAvailability` (which are usable), `pickStruck` (50/50) and `peekText`. Pure apart from the rng. |
| `constants.js` | `PACKS`, `DIFFICULTIES`, tunables, `timing`, and the `cid` custom_id builders + `parseCustomId`. |
| `state.js` | In-memory session `Map` keyed by `sid`, plus the one-timer-per-session helpers `armTimer` / `clearTimer`. |
| `db.js` | `initDb(path)` / `getDb()` / `closeDb()` / `transaction(fn)`, the numbered migrations and the stale-game cleanup. |
| `records.js` | Every database write for games: players, games, teams, questions shown, guesses, cheat uses. |
| `questions.js` | Question queries (reads only): `getQuestion`, `subjectsAvailable`, `pickQuestionForTile`, `hasUnusedQuestion`, `countActiveQuestions`. |
| `stats.js` | Stats queries (reads only) and the `/stats` text: `getPlayerStats`, `formatStats`, `bestHardRun`, Peek's `peekCount` / `peekAnswers`, and the `COUNTED` SQL condition. |
| `importer.js` | `parseQuestions` (validate CSV text), `importQuestions` (upsert), `importFile`, `seedSampleQuestions`. |
| `csv.js` | RFC 4180 CSV parser, no dependency. |
| `rng.js` | `random`, `randomInt`, `pick`, `shuffle`. All randomness goes through it so tests can call `setRng(fn)` / `resetRng()`. |
| `commands.js` | Slash-command definitions. Running it (`npm run register`) pushes them to Discord. |
| `utils.js` | `DiscordRequest` / `InstallGlobalCommands` (REST), used only by `commands.js`. |
| `questions/sample.csv` | 20 placeholder questions with negative ids. Loaded automatically when the database has no active questions. |
| `scripts/import-questions.js` | The `npm run import` script. |
| `scripts/smoke.js` | Offline end-to-end test: whole games driven through `handleInteraction`, then the database checked. |
| `scripts/fakes.js` | The fake Discord used by the smoke test (and some unit tests): a recording client, interaction builders (with `failOn` to simulate a failed acknowledgement), and `seededRng`. |
| `scripts/testdata.js` | Helpers that record finished games straight into the database (`playSolo`, `playNight`, `askQuestion`, `guessOn`), for stats and Peek tests. |
| `test/*.test.js` | Unit tests (`node:test`). |
| `DESIGN.md` | The agreed design (question bank, solo, trivia night, stats, database) and the phased build plan. |

## Database

SQLite via `node:sqlite` (`DatabaseSync`, synchronous). The schema and conventions are in
DESIGN.md "Database"; the schema itself is the `MIGRATIONS` array in `db.js`.

- `app.js` calls `initDb()` before logging in. The file is `data/trivia.db`, or
  `TRIVIA_DB_PATH`. It marks games left `in_progress` by a crash or restart as `abandoned`,
  and refuses a database whose schema is newer than the code.
- Change the schema only by **appending** a migration to `MIGRATIONS`. Never edit one that
  has shipped.
- Discord ids are TEXT everywhere. Never bind `undefined` (use `null`): `records.js` already
  normalises its optional arguments.
- `getDb()` is a process-wide connection, so unit tests call `initDb(':memory:')` in
  `beforeEach` and `closeDb()` in `afterEach`. `db.exec('BEGIN')` transactions must be
  synchronous: use `transaction(fn)`.
- Rows come back as null-prototype objects. Spread them (`{ ...row }`) before
  `assert.deepEqual`.
- Writes go through `records.js` as they happen. `importer.js` is the only writer of the
  `questions` table, and it deactivates questions rather than deleting them because guesses
  reference them.
- A guess is **counted** (toward stats) unless it was made in a Casual solo run. Casual
  guesses are still saved. `stats.js` exports `COUNTED`, the SQL condition for this: use it
  in every stats query (the games table must be aliased `gm`). A timeout is a counted guess
  that was wrong, with no `response_ms`. A solo "run" only counts toward run statistics if
  it got at least one guess.

## Interaction flow

**Setup** (ephemeral, `flow.js`): `/start` → pick a pack → **Confirm** / **Back** →
**Solo** / *Trivia night (disabled)* / **Back** → pick **Hard** / **Standard** / **Casual**
(each with a one-line description) / **Back**. Each screen is the same ephemeral message
edited with `interaction.update`. An unfinished setup is dropped after `SETUP_IDLE_MS`.

**Starting a run** (`solo.startSolo`): checks the channel has no other public game, builds
the board (if a grade has no questions it says so and stops), creates the game, players and
`game_players` rows in the database, edits the ephemeral message to "Game posted in the
channel 👇" and posts the board. Only the player can press the public game's buttons;
anyone else gets an ephemeral "This is @Player's game."

**The run** (`solo.js`), a session `status` cycle of `board → question → between → board …`:

1. **Board message:** header (pack, player, difficulty, lives, score) and one row of tile
   buttons per grade, with **Quit** at the end of the last row. Only the lowest grade with
   unplayed tiles is enabled. A `BOARD_IDLE_MS` timer abandons an untouched board.
2. **Picking a tile** picks an unused question for it (preferring ones this player has seen
   least), records it, posts a **fresh question message** and deletes the board.
   - Choice questions show shuffled `A)`–`D)` options with buttons `A`–`D`. Typed questions
     show an **Answer** button that opens a modal with one text box.
   - The message shows its deadline as `<t:UNIX:R>`. A timer (`TIMERS.solo`) is armed for it.
   - A second row of **cheat buttons** shows while the run has cheats left (see Cheats below).
3. **Answering** (or the timer firing) records the guess, edits the question message to its
   result with no buttons, waits `timing.resultReadMs`, then posts a fresh board. A miss
   costs a life.
4. **The run ends** when the board is cleared (`completed`), lives run out (`failed`),
   **Quit** is pressed (`quit`) or the board sits idle (`abandoned`). The board is deleted
   and a fresh summary is posted: result, correct/asked, misses, and for Hard the player's
   best Hard run.

| | Hard | Standard | Casual |
|---|---|---|---|
| Lives | 1 | 3 | unlimited |
| Cheats | none | 1 per run | unlimited |
| Stats | counted + own Hard section | counted | saved, not counted |

**Cheats** (`onCheat` in `solo.js`, rules in `cheats.js`). Each can be used at most once per
question, even on Casual. A cheat doesn't pause the timer. The cheat row disappears once the
run has no cheats left (always on Hard, after the first on Standard). Unavailable cheats
are drawn disabled. Every use is recorded in `cheat_uses` against the question it was used on.

| Cheat | Effect | Available when |
|---|---|---|
| **Peek** | Ephemeral reply: how other players answered, as percentages (choice letters as currently displayed; top 3 for typed). The question message is refreshed separately. | `PEEK_MIN_ANSWERS` counted, non-timeout guesses from other games |
| **50/50** | Strikes wrong choices until two remain (`q.struck`, shown as ~~text~~ with disabled buttons). | choice question with 3+ choices |
| **Swap** | Replaces the question in the same message: the old game question is marked `swapped` (no guess), the new one gets the next `seq` and a fresh timer. | another unused question exists for the tile |
| **Extra time** | Adds one base timer to the deadline and re-arms the timer. | always |

A button whose `sid` has no live session (bot restarted, game over, setup timed out) gets an
ephemeral *"That trivia session expired — run `/start` again."* (a modal submit gets
*"⏰ Too late."*). A click that is for a stale question (an old `seq`) is acknowledged with
`deferUpdate` and ignored.

## Replying to Discord

- **Acknowledge every interaction exactly once, within ~3 seconds**, with `reply`, `update`,
  `deferUpdate` or `showModal`. Acknowledge first and do slow work (posting the next board)
  afterwards. The fake client in `scripts/fakes.js` throws on a double acknowledgement.
- **Ephemeral screens:** open with `interaction.reply({ flags: MessageFlags.Ephemeral, ... })`,
  then move between screens with `interaction.update(...)`, which keeps the message
  ephemeral.
- **Public messages** (board, questions, summary) are sent, edited and deleted through the
  channel by id with `messages.js` (`client.channels.fetch(id)` → `send` /
  `messages.edit` / `messages.delete`). This is because timer callbacks have no interaction
  to reply with. The session stores `channelId` and `messageId` (the current live public
  message). Every public payload goes out with `allowedMentions: { parse: [] }`, so
  mentions show as names but never ping. Build them with `publicPayload`.
- **A fresh message per screen:** each new board or question is a new message at the bottom
  of the channel. Picking a tile deletes the board; question messages stay as history,
  edited to show their result.
- **Modals:** `interaction.showModal` must be the *first* response to the button click, so
  run the guards synchronously and call it with nothing awaited before it. The submit is a
  separate interaction (`isModalSubmit()`); answer it with `interaction.update(...)` to edit
  the question message.
- **Message format** is classic `{ content, components }`. Components V2 is deliberately not
  used.
- **Countdowns** use Discord's `<t:UNIX:R>` timestamp, which counts down on the client.
  Never poll-edit a message to show a countdown.
- **Limits:** 5 action rows per message, 5 buttons per row; button label ≤ 80 characters;
  custom_id ≤ 100; message content ≤ 2000 (`publicPayload` clamps it); modal title and
  input label ≤ 45; select menus ≤ 25 options. Interaction tokens expire after 15 minutes.
- **Commands are guild-only** (`contexts: [0]`, `integration_types: [0]`).
- **Discord setup:** the Developer Portal's *Interactions Endpoint URL* must stay
  **empty**. If it is set, Discord sends interactions there instead of to the gateway and
  every command fails. The bot needs no privileged intents, and in the channel it needs
  to view it and send messages.

## custom_id scheme

Every id is `<kind>:<sid>[:<arg>…]`. The custom_id is both the router key and the only
state a button carries. Build ids only with `cid.*` and parse them only with
`parseCustomId`, both in `constants.js`. `parseCustomId` returns `{ kind, sid, args }`
(args are strings), or `{ kind: 'unknown', sid: null, args: [], raw }`.

| `kind` | Args | Where |
|---|---|---|
| `pack` | pack key | setup: pick a pack |
| `packOk`, `packBack` | — | setup: confirm screen |
| `fmtSolo`, `fmtNight`, `fmtBack` | — | setup: format screen |
| `diff` | `hard` / `standard` / `casual` | setup: difficulty screen |
| `diffBack` | — | setup: difficulty screen |
| `tile` | tile index | board |
| `quit` | — | board |
| `ans` | `seq`, displayed position (0–3) | choice answer |
| `typed` | `seq` | opens the answer modal |
| `typedSubmit` | `seq` | the modal's own id |
| `cheat` | `seq`, `peek` / `fifty` / `swap` / `time` | cheat row on a solo question |

- `sid` is `crypto.randomUUID()` with the dashes stripped: exactly 32 hex characters.
  Kinds and args must not contain `:` (`cid.*` throws if they do) and an id must fit
  Discord's 100 characters (it throws if not).
- `seq` is the question's position in the game. A click whose `seq` isn't the current
  question is stale: `deferUpdate` and ignore it.
- Answer buttons carry the **displayed position**, never the choice letter. The session
  keeps `q.order` (position → index into `question.choices`) to translate. Tiles are
  referenced by index, never by subject text.

**Adding a button:** add a builder to `cid`, a `case` in `handleSolo` (or `handleSetup`) and
`SETUP_KINDS` if it is a setup button, a row in the table above, a test in
`test/constants.test.js` and a step in `scripts/smoke.js`.

## Sessions and timers

Created by `createSession` in `state.js`, then extended by `solo.startSolo`:

```js
{
  sid, guildId, channelId, hostId,   // hostId is the player
  status,        // 'setup' | 'board' | 'question' | 'between' | 'ending' | 'ended'
  pack, format, difficulty,   // PACKS key, 'solo', DIFFICULTIES key
  public,        // true once the session owns the channel's one public game
  gameId,        // games.id
  messageId,     // the current live public message
  timer,         // the single active setTimeout handle
  createdAt,
  run: {
    tiles,       // [{ index, grade, subject, state: 'open'|'right'|'wrong'|'skipped' }]
    usedIds,     // Set of question ids already asked
    seq,         // next game_questions.seq
    correct, misses, asked,
    livesLeft,   // Infinity on Casual
    cheatsLeft,  // Infinity on Casual, 0 on Hard
    cheatsUsed,  // for the summary
    q: {         // the question on screen (or the last one answered)
      seq, gameQuestionId, tileIndex, question,
      order,     // choice questions: position -> index into question.choices
      struck,    // positions eliminated by 50/50
      shownAtMs, deadlineMs, answered,
      cheatsUsed,    // Set of cheat kinds used on this question
      peekTotal,     // counted answers from other games, computed when shown
      swapAvailable, // another unused question exists for the tile
    },
  },
}
```

- **All state is in memory.** A restart drops every session. At startup `initDb` marks the
  games that were running as `abandoned`.
- **One public game per channel**, enforced with `findPublicSession(channelId)` at the
  moment a game is created. Claim the channel (`session.public = true`) before the first
  `await`.
- **One timer per session.** Always arm timers with `armTimer` (`state.js`). It `unref()`s
  the handle and replaces any previous timer, so each phase arms exactly one. `clearTimer` /
  `deleteSession` cancel it. Timer callbacks must `.catch` their promise, because there is
  no interaction to report errors to.
- **Race rule:** a click and a timer can both fire for the same question. Change session
  state (record the answer, clear the timer) **before the first `await`** in a handler.
  Answering and `onQuestionTimeout` both go through `openQuestion(session, seq)`, which
  requires `status === 'question'`, the current `seq` and `!q.answered`, and `settle()`
  sets `q.answered` and records the guess synchronously. Stale or duplicate clicks get a
  `deferUpdate` and change nothing. Any new timed step needs the same guards.
- After any `await` that sends a message, re-check the session is still the live one before
  touching it (see `postQuestion`).
- Channel send / edit / delete failures are caught and logged so the game loop keeps going.
  If the board or a question can't be posted at all, the run is aborted (`abandoned`) and
  the channel freed.

## Questions, answers and tunables

- Questions live in the database; see DESIGN.md "Question bank" for the CSV format and the
  README for how the user loads them. A `choice` question stores `choices` (JSON array) and
  `answer` (the original letter `A`–`D`); a `typed` question stores the canonical `answer`
  and optional `accepted` alternatives.
- Choices are shuffled every time a question is shown. Compare the **original letter**
  (`LETTERS[q.order[position]]`) against `question.answer`, never the position.
- `answers.checkTyped` normalises both sides (NFKC, lower-case, whitespace, outer
  punctuation) and compares numbers as numbers. There is no fuzzy matching.
- Typed text from players is escaped (`escapeMarkdown`) before it goes into a message.

| Tunable | Where | Value |
|---|---|---|
| `TIMERS.solo.choice` / `.typed` | `constants.js` | 20 s / 45 s answer window |
| `STANDARD_LIVES` | `constants.js` | 3 |
| `PEEK_MIN_ANSWERS` | `constants.js` | 5: counted answers needed before Peek is offered |
| `SETUP_IDLE_MS` | `constants.js` | 15 min: drop an unfinished setup |
| `BOARD_IDLE_MS` | `constants.js` | 5 min: untouched board → abandoned |
| `timing.resultReadMs` | `constants.js` | 1500: pause after a result (tests set it to 0) |
| `DIFFICULTIES`, `PACKS` | `constants.js` | the difficulties and packs |

`constants.js` also defines the later phases' tunables (`TIMERS.night`, `SIGNUP_IDLE_MS`,
`NIGHT_IDLE_MS`, `LEADERBOARD_MIN_ANSWERS`), which nothing uses yet.

## Slash commands

| Command | What it does |
|---|---|
| `/start` | Opens the ephemeral setup; see Interaction flow. |
| `/stats [user] [share]` | A player's stats (default: you) from their counted guesses: overall, by grade, by subject (top 10), Standard and Hard runs. Private unless `share` is true. A player with no counted guesses gets "No games yet. Run `/start`!" (or "@name hasn't played yet."). |

Both are defined in `commands.js` with `type: 1`, `integration_types: [0]` and
`contexts: [0]` (servers only, because games are posted by the bot into a channel).

**Adding a command:** define it in `commands.js`, add it to `ALL_COMMANDS`, handle its
`interaction.commandName` in `handleCommand` (`flow.js`) and add a step to
`scripts/smoke.js`. Then tell the user to run `npm run register`. Global commands can take
a few minutes to appear.

## Known gaps

- **Trivia night is not implemented** (Phase 5): its setup button is disabled.
- **No `/leaderboard`** yet (Phase 6), and `/stats` has no trivia-night section (Phase 5).
- Quit only exists on the board, so a player in the middle of a question can't quit until it
  is answered or times out.
- A restart abandons games in progress. Their messages stay in the channel with dead
  buttons, which answer with the "expired" reply.
- If the bank changes under a running game (an import deactivates a tile's questions), that
  tile is marked skipped (➖) and the run continues.
- The smoke test uses a fake Discord, so it can't catch problems that only the real API
  shows (permissions, rate limits, a message that was deleted by a moderator).

## Roadmap

The full design and build plan are in [DESIGN.md](DESIGN.md). It is the spec, so follow it,
and record any judgment call in its Decisions log. The phases, in order:

1. **Database and question import** — done.
2. **Solo board game** — done.
3. **Cheats** (Peek, 50/50, Swap, Extra time) — done.
4. **Stats:** `/stats` — done.
5. **Trivia night:** sign-up, teams, rotating answerers, Ask a teammate, host controls.
6. **Leaderboard and analysis:** `/leaderboard` and saved SQL queries.
