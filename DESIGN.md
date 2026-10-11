# Design

The agreed design for the trivia bot, plus a build plan for implementing it. [AGENTS.md](AGENTS.md)
describes the code as it is today. This file describes where it is going.

**Status:** nothing in this document is built yet unless its phase is ticked in the
[Build plan](#build-plan).

## Vision

A Discord trivia bot with two ways to play:

- **Solo:** one player runs through a board of questions at a chosen difficulty and builds
  up personal stats, overall and per category.
- **Trivia night:** a host runs a game for a group. Players sign up, get split into teams,
  and the teams compete on the same questions.

Questions live in a private local database, never in the public repo. Every guess is
recorded so stats can be analyzed later.

The first question pack is **"Are You Smarter Than a Fifth Grader"**, organized by grade
(1st–5th) and subject. Other smaller packs will be added later, so nothing should assume
Fifth Grader is the only pack. The bot runs on one server, but nothing may hard-code a
server or channel. It must work on any server.

## Terms

| Term | Meaning |
|---|---|
| **Pack** | A question set with its own theme, e.g. `fifthgrader`. Replaces the old word "mode" in the code. |
| **Format** | `solo` or `night` (trivia night). |
| **Difficulty** | Solo only: `hard`, `standard` or `casual`. |
| **Board** | The grid of tiles for one game (solo) or one round (night). |
| **Tile** | One square on the board: a grade + subject pair, e.g. "3rd · Science". Picking a tile asks a question from that grade and subject. |
| **Run** | One solo game, from the first tile to the end. |
| **Miss** | A wrong answer or a timeout. |
| **Lives** | How many misses a solo run can take before it ends. |
| **Cheat** | A solo power-up: Peek, 50/50, Swap or Extra time. |
| **Answerer** | On a trivia night, the one team member allowed to answer the current question. |
| **Assist** | "Ask a teammate": a trivia-night team's once-per-game help, letting another member answer instead. |
| **Counted** | A guess that counts toward stats: every guess except those made in Casual runs. |

## Question bank

### CSV format

The user compiles questions in a spreadsheet and exports it as **CSV UTF-8**. The private
file lives at `data/questions.csv` by default. The whole `data/` folder is gitignored.

| Column | Required | Rules |
|---|---|---|
| `id` | yes | Positive whole number, unique in the file. Never changed or reused: stats point at it. |
| `pack` | yes | A pack key from `PACKS` in `constants.js`, e.g. `fifthgrader`. |
| `grade` | for `fifthgrader` | Whole number 1–5. Empty for packs without grades. |
| `subject` | yes | Free text, max 40 characters. Spelling matters: stats group by it. |
| `type` | yes | `choice` (multiple choice) or `typed` (free-text answer). |
| `prompt` | yes | The question, max 1000 characters. |
| `choice_a`–`choice_d` | for `choice` | 2–4 choices filled from A onwards with no gaps, each max 200 characters and all different. Empty for `typed`. |
| `answer` | yes | `choice`: the letter of the correct choice (A–D, any case). `typed`: the canonical answer. |
| `accepted` | no | `typed` only: other accepted answers separated by `;`, e.g. `twelve;12.0`. |
| `source` | no | Where the question came from (URL or note). |

Columns are matched by header name, so their order doesn't matter. Unknown columns are
ignored with a warning. Values are trimmed. The parser follows RFC 4180: comma-separated,
double-quoted fields may contain commas, quotes (`""`) and newlines, line endings are LF or
CRLF, and a UTF-8 BOM at the start is stripped. No CSV dependency is used; the parser is
`csv.js`.

### Import

`npm run import [path]` (default `data/questions.csv`) loads the CSV into the database:

- It validates every row first. If any row is invalid it prints every error with its CSV
  line number (e.g. `line 14: answer "E" is not one of the filled choices (A–C)`) and
  imports **nothing**.
- Valid files are imported in one transaction. Rows are upserted by `id`. Questions in the
  database that are missing from the file are set `active = 0`, never deleted, because
  guesses reference them.
- It prints a summary: new, updated and deactivated counts, plus a count per pack, grade
  and subject.

### Sample questions

`questions/sample.csv` is committed so a fresh clone can play. It has 20 obviously simple
placeholder questions (prompts start with `[Sample]`): grades 1–5, two subjects per grade
and two questions per subject, with at least one `typed` question per grade. Sample ids
are **negative** (-1 to -20) so they can never collide with real ids.

When the bot starts and the database has **no active questions**, it imports the sample
file automatically and logs a warning telling the user to run `npm run import`. A real
import deactivates the samples, because they aren't in the real file.

### Keeping answers secret

- Real questions never go into git: only `questions/sample.csv` is committed.
- Players can read every custom_id in their Discord client, so **a custom_id must never
  reveal the answer**. Answer buttons carry the *displayed position* (0–3), not the
  original letter. The session keeps the mapping from position to original letter.
- Choices are shuffled every time a question is shown, so the column the correct answer
  sits in doesn't matter.
- Whether a guess was right is only revealed in the result. Trivia-night players get a
  private "Locked in" message, so other teams never see what they picked.

## Answer checking

`answers.js` holds pure functions so they're easy to unit-test.

- **`choice`:** the clicked position maps to an original letter, which is compared with
  `answer`.
- **`typed`:** both the guess and each accepted answer (`answer` plus every `accepted`
  entry) are normalized, then compared:
  1. Unicode NFKC, lowercase, trim, collapse runs of whitespace into one space.
  2. Strip leading and trailing characters that aren't letters or digits (`"Paris."` →
     `paris`, `"$5"` → `5`).
  3. If both sides parse as finite numbers after removing thousands separators
     (`1,000` → `1000`), compare them as numbers (`12` = `12.0`).
  4. Otherwise compare the strings exactly. There is no fuzzy matching: a typo is wrong.
     Add common variants to `accepted` instead.

## Fifth Grader board

- 5 grades × 2 tiles = 10 tiles. Tile labels read `1st · Spelling`, `2nd · Math` and so
  on.
- **Building a board:** for each grade, pick 2 different subjects at random from the
  subjects that still have an unused active question at that grade. If only one subject
  qualifies, that grade gets one tile. If a grade has none, the game can't start: tell the
  user to import more questions.
- **Climb rule:** only the lowest grade with unplayed tiles is clickable. Higher grades
  show as disabled. A played tile shows ✅ or ❌ and is disabled.
- **Layout:** one action row per grade (5 rows, 1–2 tiles each). The control button
  (solo **Quit**, night **End night**) goes at the end of the 5th-grade row, because
  Discord allows only 5 rows.
- **Picking a question for a tile:** a random active question with that grade and
  subject, not used earlier in this game (for a night, earlier in the whole night). In solo,
  prefer questions the player has guessed on the fewest times.

## Solo

### Setup (ephemeral)

`/start` → pick a pack → Confirm / Back → **Solo** / **Trivia night** / Back → pick a
difficulty (Hard / Standard / Casual, each with a one-line description) / Back.

Picking a difficulty creates the game, changes the ephemeral message to "Game posted in the
channel 👇" and posts the board publicly. Only the player can click the public game's
buttons. Anyone else gets an ephemeral "This is @Player's game."

### Difficulties

| | Hard | Standard | Casual |
|---|---|---|---|
| Lives | 1 (the first miss ends the run) | 3 (the third miss ends the run) | unlimited |
| Cheats | none | 1 per run, any type | unlimited (each cheat at most once per question) |
| Stats | counted, plus its own Hard section | counted | saved but not counted |

### A run

1. **Board message:** a header line with the player, difficulty, lives (❤️), cheats left
   (🃏) and score, then the board.
2. **Pick a tile:** the board message is deleted and a fresh **question message** is
   posted. It shows the tile, the prompt, the choices as `A) …` lines, and the deadline as
   `<t:UNIX:R>`.
   - `choice`: buttons `A`–`D` in row 1.
   - `typed`: one **Answer** button that opens a modal with a single text input.
   - Row 2: the cheat buttons (if the difficulty has cheats left).
3. **Answer or timeout:** the question message is edited to show the result (✅ / ❌, plus
   the correct answer on a miss) with no buttons. Then either a fresh board message is
   posted, or the run ends.
4. **Run ends** when the board is cleared (status `completed`), lives run out (`failed`),
   the player presses Quit (`quit`), or the board sits idle too long (`abandoned`). A
   fresh summary message shows the result, correct/asked, misses, cheats used and, for
   Hard, the player's best Hard run.

### Cheats

| Cheat | Effect | Available when |
|---|---|---|
| **Peek** | Ephemeral to the player: how other players answered this question, e.g. `A 10% · B 61% · C 22% · D 7% (23 answers)`, shown with the current display letters. For `typed`, the top 3 normalized answers with percentages. | The question has at least `PEEK_MIN_ANSWERS` counted, non-timeout guesses from other games. |
| **50/50** | Strikes out wrong choices until 2 remain (~~struck~~ in the text, buttons disabled). | `choice` question with 3+ choices. |
| **Swap** | Replaces the question with another unused active question from the same grade and subject, edited into the same message, with a fresh timer. The swapped-out question gets no guess. | Such a question exists. |
| **Extra time** | Adds one full base timer to the deadline and updates the countdown. | Always. |

Unavailable cheats render disabled. A cheat doesn't pause the timer. In Standard, once
the run's one cheat is used, the cheat row disappears for the rest of the run.

## Trivia night

### Sign-up and teams

1. In setup the host picks a pack and then **Trivia night**. The ephemeral message changes
   to "Sign-up posted in the channel 👇".
2. **Public sign-up message:** host, roster, and **Join** / **Leave** (anyone, including
   the host) plus **Make teams** / **Cancel** (host only; others get an ephemeral "Only
   the host can do that").
3. **Make teams** closes sign-up and shows the host an ephemeral team builder:
   - **Team count:** 2, 3 or 4. Only counts no larger than the number of players are
     enabled.
   - Players are shuffled and dealt round-robin into teams named 🟥 Red, 🟦 Blue, 🟩 Green,
     🟨 Yellow.
   - **Shuffle** re-deals. **Move a player** offers a player select and then a team select.
     **Back** reopens sign-up. **Start** begins the night (every team needs at least 1
     player).
4. **Start** creates the game and team records, edits the sign-up message to list the
   final teams with no buttons, and posts the first board.

Each team's **answer order** is fixed at Start: alphabetical by server display name
(case-insensitive), with ties broken by user id. It doesn't change if someone renames.

### Playing a board

- **Tile picking rotates between teams** in team order (Red, Blue, Green, Yellow, Red, …),
  continuing across boards. The picking team's current answerer picks. The host may also
  pick, in case someone is AFK. Anyone else gets an ephemeral "It's @Alice's (🟥 Red) pick."
- The board header shows the board number, team scores and whose pick it is.
- **Question message:** prompt, choices, deadline, and one status line per team, e.g.
  `🟥 Red: @Alice ⏳` / `🟦 Blue: @Bob 🔒`. Row 1 holds the answer buttons (or **Answer**
  for typed). Row 2 holds **🙋 Ask a teammate**.
- **All teams answer the same question at the same time.** Only each team's current
  answerer can submit, once. They get an ephemeral `🔒 Locked in: B`, and their team's
  status line turns to 🔒. Anyone else who clicks gets an ephemeral "It's @Alice's turn
  for 🟥 Red" (or "You're not playing in this game").
- **No conferring:** the game assumes the answerer decides alone. All teams can share one
  voice call, where the host reads the questions aloud.
- **Ask a teammate:** before their team locks in, the current answerer can press it to get
  an ephemeral select of their teammates. The chosen teammate answers this question
  instead, and the status line shows `@Carol (for @Alice)`. Each team gets one per game
  (the whole night). It needs a team of 2+. Afterwards it replies "Already used". The
  answer order isn't affected.
- **The question ends** when every team has locked in or the timer expires. A team that
  didn't answer gets a timeout miss.
- **Reveal:** the question message is edited to show the correct answer, each team's answer
  with ✅/❌, and the scores. Host-only buttons: **Next ▶** (posts the next board) and
  **End night**. On the last tile of a board, Next is replaced by **Play another board**.
  It is disabled if there aren't enough unused questions for another board.
- After each question, **every team's answer order advances** to the next member.

### Scoring and ending

- 1 point per correct team answer. There are no lives in a trivia night: every tile is
  played.
- **End night** (or the end of the last board followed by End night) posts the final
  standings with each team's members. The top-scoring team or teams win, and ties share
  the win.
- Status is `completed`. If the night ends before any question was asked, status is `quit`
  and no wins are recorded.

## Stats

### What counts

- Every guess is saved, including timeouts, which are recorded as wrong with no answer.
  Casual guesses are saved but excluded from all stats.
- Swapped-out questions have no guess.
- On a trivia night, the guess belongs to whoever actually answered (the helper, when
  assisted), and it counts toward their global stats.
- "Global" means across every server. Leaderboards are per server (`games.guild_id`).

### `/stats [user] [share]`

Shows a player's stats (default: yourself). Ephemeral unless `share` is true. Keep it under
2000 characters.

- **Overall** (counted guesses): answered, correct, % correct, average answer time
  (excluding timeouts).
- **By grade:** % correct for each of grades 1–5.
- **By subject:** % correct for the 10 most-answered subjects.
- **Solo:** Standard runs, clears, best score. Hard runs, clears, best run (most correct in
  one Hard run). Average correct per counted solo run.
- **Trivia nights:** nights played, team wins, questions answered as answerer, % correct,
  assists given.
- With no data: "No games yet. Run /start!"

### `/leaderboard [by]`

Public, for the current server, top 10. `by` is one of: `accuracy` (minimum
`LEADERBOARD_MIN_ANSWERS` counted guesses), `correct`, or `wins` (trivia-night team wins).

## Database

SQLite through Node's built-in **`node:sqlite`** (`DatabaseSync`), so no npm dependency is
needed. This requires Node ≥ 22.13. The database file is `data/trivia.db` by default, or
`TRIVIA_DB_PATH` if set; `:memory:` is used in tests.

On open: create `data/` if needed, `PRAGMA foreign_keys = ON`, `PRAGMA journal_mode = WAL`
(file databases only), and run migrations tracked with `PRAGMA user_version`. Then mark
any game still `in_progress` as `abandoned`, because a restart lost its in-memory state.

Conventions:

- Discord ids (users, guilds, channels) are always stored as **TEXT**. Snowflakes don't
  fit in a JS number.
- Timestamps are ISO 8601 UTC strings (`new Date().toISOString()`).
- Booleans are `INTEGER` 0/1.
- Write each guess and cheat use the moment it happens, not at the end of the game.

### Schema (migration 1)

```sql
CREATE TABLE questions (
  id          INTEGER PRIMARY KEY,           -- from the CSV; negative = bundled sample
  pack        TEXT NOT NULL,
  grade       INTEGER,                        -- 1-5 for fifthgrader, NULL otherwise
  subject     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('choice', 'typed')),
  prompt      TEXT NOT NULL,
  choices     TEXT,                           -- JSON array of strings ('choice'), NULL for 'typed'
  answer      TEXT NOT NULL,                  -- 'choice': letter A-D; 'typed': canonical answer
  accepted    TEXT,                           -- JSON array of extra accepted answers, or NULL
  source      TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_questions_tile ON questions (pack, grade, subject, active);

CREATE TABLE players (
  user_id       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,                -- last seen server display name
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);

CREATE TABLE games (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT,
  channel_id  TEXT NOT NULL,
  pack        TEXT NOT NULL,
  format      TEXT NOT NULL CHECK (format IN ('solo', 'night')),
  difficulty  TEXT CHECK (difficulty IN ('hard', 'standard', 'casual')),  -- NULL for nights
  host_id     TEXT NOT NULL,                  -- the solo player, or the night's host
  status      TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'quit', 'abandoned')),
  started_at  TEXT NOT NULL,
  ended_at    TEXT
);

CREATE TABLE teams (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id   INTEGER NOT NULL REFERENCES games(id),
  name      TEXT NOT NULL,                    -- 'Red', 'Blue', 'Green', 'Yellow'
  position  INTEGER NOT NULL,                 -- 0-based team order (tile-picking order)
  score     INTEGER NOT NULL DEFAULT 0,
  won       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE game_players (
  game_id     INTEGER NOT NULL REFERENCES games(id),
  user_id     TEXT NOT NULL REFERENCES players(user_id),
  team_id     INTEGER REFERENCES teams(id),   -- NULL for solo
  turn_order  INTEGER,                        -- 0-based answer order within the team
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE game_questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id      INTEGER NOT NULL REFERENCES games(id),
  question_id  INTEGER NOT NULL REFERENCES questions(id),
  seq          INTEGER NOT NULL,              -- 0-based order asked within the game
  board        INTEGER NOT NULL DEFAULT 0,    -- board number within a night
  grade        INTEGER,                       -- the tile it was asked from
  subject      TEXT,
  picked_by    TEXT,                          -- user id who picked the tile
  shown_at     TEXT NOT NULL,
  swapped      INTEGER NOT NULL DEFAULT 0     -- 1 if replaced by Swap
);

CREATE TABLE guesses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  game_question_id  INTEGER NOT NULL REFERENCES game_questions(id),
  game_id           INTEGER NOT NULL REFERENCES games(id),
  question_id       INTEGER NOT NULL REFERENCES questions(id),
  user_id           TEXT NOT NULL REFERENCES players(user_id),
  team_id           INTEGER REFERENCES teams(id),
  answer            TEXT,                     -- 'choice': original letter; 'typed': raw text; NULL on timeout
  correct           INTEGER NOT NULL,
  timed_out         INTEGER NOT NULL DEFAULT 0,
  assisted          INTEGER NOT NULL DEFAULT 0,  -- 1 if answered via Ask a teammate
  assigned_user_id  TEXT,                     -- when assisted: the answerer who asked for help
  response_ms       INTEGER,                  -- from game_questions.shown_at; NULL on timeout
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_guesses_user ON guesses (user_id);
CREATE INDEX idx_guesses_question ON guesses (question_id);

CREATE TABLE cheat_uses (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  game_question_id  INTEGER NOT NULL REFERENCES game_questions(id),
  game_id           INTEGER NOT NULL REFERENCES games(id),
  user_id           TEXT NOT NULL,
  cheat             TEXT NOT NULL CHECK (cheat IN ('peek', 'fifty', 'swap', 'extra_time')),
  created_at        TEXT NOT NULL
);
```

Later schema changes go in new numbered migrations. Never edit migration 1 once it has
shipped.

## Discord details

- **Fresh message per screen.** Each new board or question is posted as a new message at
  the bottom of the channel, so it doesn't scroll away during a busy night:
  - Picking a tile deletes the board message. A bot can always delete its own messages.
  - Question messages stay as history, edited to show their result.
  - The session's `messageId` is always the current live message.
- **No pings:** send every bot message with `allowedMentions: { parse: [] }`. Mentions
  still render as names but don't notify anyone.
- **Guild-only commands:** set `contexts: [0]` and `integration_types: [0]` on every
  command, because games post as the bot in a server channel. The user must re-run
  `npm run register` after this changes.
- **Modals:** `showModal` must be the *first* response to the button click. Run the guards
  synchronously, then call it with no `await` before it. A modal submit is a separate
  interaction (`isModalSubmit()`) with its own custom_id. If it arrives after the question
  ended, reply ephemerally "⏰ Too late."
- **Interaction types to route:** chat-input commands, buttons, string select menus
  (team builder, Ask a teammate) and modal submits.
- **Limits:**
  - 5 action rows per message and 5 buttons per row.
  - Button labels max 80 characters, custom_id max 100.
  - Message content max 2000 characters.
  - Select menus max 25 options, so a night has at most 25 players.
  - Modal title and text-input label max 45 characters each (truncate).
  - Interaction tokens expire after 15 minutes. That's why public messages are edited
    through the channel, not the interaction.
- **Display names:** `interaction.member?.displayName ?? interaction.user.globalName ??
  interaction.user.username`. Upsert the `players` row whenever someone joins or guesses.
- **One public game per channel:** before posting a solo board or a night sign-up, check
  the channel has no active public game or sign-up. If it does, reply ephemerally "A game
  is already running in this channel." Setup screens are not limited.

## Code layout

Target layout. Split `flow.js` as the game grows, and keep `handleInteraction` as the
single router.

```
app.js           gateway shell: initDb(), seed samples if needed, log in, route interactions
flow.js          handleInteraction router + /start setup screens
solo.js          solo runs: board, questions, cheats, end of run
night.js         trivia night: sign-up, team builder, rounds, reveal, end
board.js         board building + rendering shared by solo and night
ui.js            button / row / select / modal builders, question rendering
messages.js      send / edit / delete public messages by channel id
answers.js       typed-answer normalization + answer checking (pure)
cheats.js        cheat rules: availability, 50/50 selection, Peek text
questions.js     question queries: pick for a tile, availability checks, Peek distribution
csv.js           RFC 4180 CSV parser (pure)
importer.js      CSV validation + upsert into the database, sample seeding
db.js            open the database, migrations
records.js       writes: players, games, teams, game_questions, guesses, cheat uses
stats.js         reads: /stats and /leaderboard queries + formatting
rng.js           random() and shuffle(), replaceable in tests for deterministic boards
constants.js     tunables, PACKS, cid builders, parseCustomId
state.js         in-memory sessions + timers
commands.js      slash-command definitions
scripts/import-questions.js   npm run import
scripts/smoke.js              offline end-to-end test with a fake client
scripts/fakes.js              the fake Discord client + interaction builders the smoke test uses
scripts/testdata.js           helpers that record finished games straight into the database
questions/sample.csv          committed placeholder questions
test/*.test.js                unit tests (node:test)
docs/queries.sql              example analysis queries
data/                         gitignored: trivia.db, questions.csv
```

## custom_id scheme

Move to `<kind>:<sid>[:<arg>…]`, where `parseCustomId` splits on `:` and returns
`{ kind, sid, args }`. Kinds and args never contain `:`. `sid` stays 32 hex characters.
Tiles are referenced by index, never by subject text.

| Kind | Args | Where |
|---|---|---|
| `pack` | pack key | setup: pick a pack |
| `packOk`, `packBack` | — | setup: confirm screen |
| `fmtSolo`, `fmtNight`, `fmtBack` | — | setup: format screen |
| `diff` | `hard` / `standard` / `casual` | setup: difficulty screen |
| `diffBack` | — | setup: difficulty screen |
| `tile` | tile index | board |
| `quit` | — | solo board |
| `ans` | seq, displayed position | choice answer |
| `typed` | seq | opens the answer modal |
| `typedSubmit` | seq | modal submit |
| `cheat` | seq, `peek` / `fifty` / `swap` / `time` | solo question |
| `join`, `leave`, `makeTeams`, `cancelNight` | — | night sign-up |
| `teamCount` | n | team builder |
| `shuffle`, `moveStart`, `startNight`, `builderBack` | — | team builder |
| `movePlayer` | — | team builder: player select |
| `moveTo` | user id | team builder: team select |
| `assist` | seq | night question |
| `assistPick` | seq | night: teammate select |
| `next`, `anotherBoard`, `endNight` | — | night reveal / board |

`seq` is the question's position in the game. A click whose `seq` isn't the current
question is stale: `deferUpdate` and ignore it. The race rule from AGENTS.md still holds:
change state before the first `await`, and guard every answer and timeout on status +
`seq` + "not already answered" (per team on a night).

## Tunables

| Name | Default | Meaning |
|---|---|---|
| `TIMERS.solo.choice` / `.typed` | 20 s / 45 s | Solo answer window |
| `TIMERS.night.choice` / `.typed` | 30 s / 60 s | Night answer window (the host reads the question aloud) |
| `STANDARD_LIVES` | 3 | Lives in Standard |
| `PEEK_MIN_ANSWERS` | 5 | Prior counted guesses needed before Peek is offered |
| `SETUP_IDLE_MS` | 15 min | Drop an unfinished ephemeral setup |
| `BOARD_IDLE_MS` | 5 min | Solo board with no tile picked → `abandoned` |
| `SIGNUP_IDLE_MS` | 30 min | Night sign-up never started → cancelled |
| `NIGHT_IDLE_MS` | 30 min | Night with no activity → `abandoned` |
| `LEADERBOARD_MIN_ANSWERS` | 20 | Minimum counted guesses to rank by accuracy |

## Build plan

### Working through the plan

These rules apply when an agent works through the phases on its own:

- **Order:** do the phases in order. A phase is done when `npm test` passes, AGENTS.md and
  README.md describe the new state of the code, and its box below is ticked.
- **Commits:** end each phase with **one commit**, using the one-line message given. No
  body, no AI attribution. (This counts as the user asking for commits, as AGENTS.md
  requires.)
- **Ambiguity:** don't stop to ask. Pick the simplest option consistent with this
  document, add a line to the [Decisions log](#decisions-log), and keep going.
- **Dependencies:** don't add any npm dependencies. Everything here can be done with Node
  built-ins (`node:sqlite`, `node:test`, `node:crypto`).
- **Off-limits:** never run `npm start`, `npm run dev` or `npm run register`, and never
  read or modify `.env` or anything in `data/`. Tests use `:memory:` or a temp directory.
- **Testing:** keep `scripts/smoke.js` driving the real flow with fake interactions. Call
  timeout handlers directly instead of waiting on real timers, and stub `rng.js` for
  deterministic boards.
- **Final report:** list what the user must do: run `npm run register` if commands
  changed, and `npm run import` with their CSV.

### Phase 1: Database and question import

- [x] `package.json`: `engines.node` `>=22.13`; scripts `"test": "node --test && node scripts/smoke.js"`
  and `"import": "node scripts/import-questions.js"`. Add `data/` to `.gitignore`.
- [x] `db.js` as specified in [Database](#database), with `initDb(path)` and migration 1.
- [x] `csv.js`, the import validation and upsert logic (shared by the script and the
  auto-seed), `scripts/import-questions.js`, and `questions/sample.csv`.
- [x] `records.js` with the writes the solo game needs: players, games, game_questions,
  guesses, cheat uses.
- [x] `rng.js`.
- [x] `app.js` calls `initDb()` and seeds the samples when no active questions exist,
  before logging in.
- [x] Unit tests: CSV parsing (quotes, embedded commas and newlines, `""`, BOM, CRLF), every
  validation error, upsert + deactivate, migrations safe to run twice, abandoning stale
  `in_progress` games.
- [x] The existing game flow is untouched and the smoke test still passes.
- [x] README: Node 22.13+, how to export the spreadsheet as CSV UTF-8 and run
  `npm run import`.

Commit: `Add SQLite database and question import`

### Phase 2: Solo board game

- [x] Rename modes to packs (`MODES` → `PACKS`) and move to the new custom_id scheme.
- [x] Setup screens: pack → confirm → format (**Trivia night** shown disabled, "coming
  soon") → difficulty.
- [x] Board building and rendering, the climb rule, and question messages for `choice`
  (shuffled, position-based buttons) and `typed` (modal).
- [x] `answers.js` normalization and checking.
- [x] Lives per difficulty, Quit, idle timers, the end-of-run summary, the
  fresh-message-per-screen flow, `allowedMentions`, and one public game per channel.
- [x] Record players, games, game_questions and guesses as they happen.
- [x] Commands become guild-only.
- [x] Delete `trivia.js` and `questions/aystafg.json`. Remove the unused `getRandomEmoji`
  and `capitalize` from `utils.js`.
- [x] Tests:
  - Unit tests for normalization (case, punctuation, numbers, thousands separators,
    accepted list), board building (stubbed rng, missing subjects, climb rule) and
    question picking.
  - Smoke test: a full Standard run with a typed question via modal, a miss and a timeout;
    a Hard run ending on its first miss; a stale click; a non-player click; and a check of
    the database rows afterwards.

Commit: `Add solo board game with difficulties`

### Phase 3: Cheats

- [x] Peek, 50/50, Swap and Extra time with the availability rules, the per-difficulty
  limits and `cheat_uses` records.
- [x] Tests:
  - Unit tests for availability.
  - Smoke test: a Casual run using every cheat, and a Standard run showing the cheat row
    disappears after one use.

Commit: `Add cheats to solo games`

### Phase 4: Stats

- [x] `stats.js` and `/stats [user] [share]`, without the trivia-night section yet.
- [x] Tests:
  - Unit tests against an in-memory database seeded with known games, checking every
    number, including that Casual is excluded and timeouts count as wrong.
  - Smoke step for `/stats`.

Commit: `Add /stats command`

### Phase 5: Trivia night

- [ ] Enable **Trivia night**: sign-up, team builder, answer order, tile-pick rotation,
  simultaneous answering, Ask a teammate, reveal and host controls, more boards, scoring,
  wins and idle timers.
- [ ] Record teams, game_players (with `turn_order`) and guesses (with `team_id` and
  assist fields).
- [ ] Add the trivia-night section to `/stats`.
- [ ] Tests:
  - Unit tests for answer order, pick rotation and winners/ties.
  - Smoke test: 2 teams × 2 players play a full board, with an assist, a typed answer, a
    not-your-turn click, one team timing out, then Play another board and End night, and a
    check of the database rows.

Commit: `Add trivia night with teams`

### Phase 6: Leaderboard and analysis

- [ ] `/leaderboard [by]`.
- [ ] `docs/queries.sql` with commented example queries:
  - per-player average correct per run
  - per-question accuracy and guess distribution (hardest and easiest questions)
  - accuracy by grade and by subject
  - average answer time
  - trivia-night team results
  - Ask a teammate outcomes
- [ ] README: how to open `data/trivia.db` in DB Browser for SQLite and run the queries.

Commit: `Add leaderboard and analysis queries`

## Decisions log

Defaults chosen while writing this design. Each is easy to change. Agents add a line here
for every judgment call they make during implementation.

- Standard's 3 lives means the third miss ends the run.
- Each cheat can be used at most once per question, even in Casual.
- Peek is based on counted, non-timeout guesses from other games.
- Trivia nights score 1 point per correct answer, with no bonus for higher grades. Ties
  share the win.
- The host can pick a tile on any team's turn, so an AFK answerer can't stall the night.
- Making teams closes sign-up. Back in the team builder reopens it.
- Typed answers are matched exactly after normalization, with no fuzzy matching.
- Solo games are public in the channel (anyone can watch) but only the player can click.
- Commands are guild-only.
- Phase 1: the import code lives in `importer.js` (validate, upsert, seed), shared by
  `scripts/import-questions.js` and `app.js`. `PACKS` was added to `constants.js`, and
  `MODES` stays as an alias of it until Phase 2 replaces it.
- Phase 1: CSV header names are trimmed and matched case-insensitively. Choices are
  compared case-insensitively when checking they are all different. A `typed` answer has
  no length limit. Rows with more non-empty values than the header has columns are an
  error; shorter rows are padded with empty values.
- Phase 1: a database whose `user_version` is newer than the code's migrations is
  refused with an error instead of being used, because older code could corrupt a newer
  schema.
- Phase 1: the sample questions are loaded without deactivating anything. A real
  `npm run import` deactivates them, since they aren't in the real file.
- Phase 2: `cid` only has builders for the kinds that exist so far. Each later phase adds
  its own. `parseCustomId` returns `{ kind, sid, args }` with `args` as strings.
- Phase 2: a tile can only be played after the lower grades are done, and both tiles of a
  grade must be played before the next grade opens. Tiles within a grade are ordered
  alphabetically by subject so the layout is stable.
- Phase 2: if a tile has no unused question when it is pressed (an import deactivated them
  while the game was running), the tile becomes `skipped` (➖, no guess, no life lost)
  instead of erroring. If that was the last open tile the run completes.
- Phase 2: the question number shown is "questions answered so far + 1", so it isn't
  affected by `seq` (which Swap will advance in Phase 3).
- Phase 2: a result message always names the correct answer, even when the player was
  right. A typed guess is stored as typed (trimmed, at most 200 characters) and shown with
  Markdown escaped.
- Phase 2: if the bot can't post the board or a question, the game is recorded as
  `abandoned`, the channel is freed, and the player gets an ephemeral note.
- Phase 2: Quit and the idle timeout delete the board before posting the summary, so no
  dead buttons are left behind. A finished run's old question messages stay as history.
- Phase 2: every press on a setup screen restarts its `SETUP_IDLE_MS` timer, so it only
  expires after 15 idle minutes.
- Phase 2: `/start` used outside a server replies with an ephemeral note, as a safety net
  even though the command is registered guild-only.
- Phase 2: the question-picking preference for fewer-seen questions counts every earlier
  guess by that player on the question, including timeouts and Casual ones.
- Phase 2: the typed-answer text box allows up to 100 characters.
- Phase 3: Swap consumes a `seq` (the swapped-out question keeps its `game_questions` row
  with `swapped = 1`, the replacement gets the next `seq`), so buttons from the old
  question go stale on their own. A swapped-in question starts with a fresh set of
  used cheats, so on Casual every cheat is available again on it.
- Phase 3: a cheat is recorded in `cheat_uses` against the question it was used on, which
  for Swap is the question that was swapped out.
- Phase 3: Peek's data count and Swap's availability are worked out once, when a question
  is shown, not on every redraw.
- Phase 3: Peek replies privately, and the question message is refreshed separately by id
  so the used Peek button turns off.
- Phase 3: 50/50 strikes `choices - 2` wrong answers (one on a 3-choice question, two on a
  4-choice question) and is not offered on 2-choice questions.
- Phase 3: Peek's typed-answer summary groups guesses by their normalised text and lists
  them with that normalised text.
- Phase 3: Quit only exists on the board. A player mid-question can't quit until the
  question is answered or times out.
- Phase 4: a solo run only counts as a run (for run totals, clears, best score and the
  per-run average) if it got at least one guess. Abandoned boards that were never played
  are ignored.
- Phase 4: "best" for Standard is the most correct answers in one Standard run, the same
  measure as Hard's best run. The per-run average covers Standard and Hard runs together.
- Phase 4: percentages are rounded to whole numbers; the average answer time to one
  decimal place of seconds. By-subject groups by subject name across packs.
- Phase 4: sections with nothing to show are left out of `/stats` (no Hard line without a
  Hard run), except By grade, which always lists all five grades and shows `–` for a grade
  never asked.
- Phase 4: when the viewed player has no counted guesses, the reply is "No games yet. Run
  `/start`!" for yourself and "@name hasn't played yet." for someone else.
