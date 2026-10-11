# Discord Trivia Bot

A Discord bot for running trivia in a server. You can play **Are You Smarter Than a Fifth
Grader** two ways: **solo**, climbing a board of grade + subject tiles from 1st to 5th grade
against a timer, or as a **trivia night**, where a host splits a group into teams that answer
the same questions together. Every game and guess is saved so you can look at stats (and dig
into the raw data) afterwards.

This is a **gateway** bot built on [discord.js](https://discord.js.org/). It connects out to
Discord over a websocket, so it shows as online in the member list and there is no public
URL, tunnel, or endpoint to configure — `npm start` is all it takes to run it.

## Requirements

- [Node.js](https://nodejs.org/) 22.13 or newer (the bot uses Node's built-in SQLite, so
  there is no database to install)
- A Discord application — create one at <https://discord.com/developers/applications>

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your Discord app

In the [Developer Portal](https://discord.com/developers/applications), create an
application, then add a bot to it (**Bot** tab). You'll need two values:

| Where to find it | Goes in `.env` as |
| --- | --- |
| General Information → **Application ID** | `APP_ID` |
| Bot → **Reset Token** (shown once) | `DISCORD_TOKEN` |

Also make sure **General Information → Interactions Endpoint URL** is **empty**. If a URL
is set there, Discord sends interactions to it instead of the gateway and every command
will fail. No privileged intents are needed.

### 3. Fill in `.env`

Copy the sample and put your two values in it:

```bash
cp .env.sample .env
```

```
APP_ID=your-application-id
DISCORD_TOKEN=your-bot-token
```

`.env` is gitignored and must never be committed. See [Working with `.env`](#working-with-env)
below.

### 4. Register the slash command

```bash
npm run register
```

This installs the slash commands globally for your app, for use in servers (not DMs).
Re-run it whenever `commands.js` changes. Global commands can take a few minutes to appear in
clients the first time.

### 5. Add your questions

Questions live in a local SQLite database (`data/trivia.db`), not in the repo, so nobody
can read the answers from GitHub. You write them in a spreadsheet and load them with one
command.

1. In your spreadsheet, use these column headers (the order doesn't matter):

   | Column | What goes in it |
   | --- | --- |
   | `id` | A unique whole number for each question. Never change or reuse one: stats point at it. |
   | `pack` | `fifthgrader` |
   | `grade` | 1–5 (leave empty for packs without grades) |
   | `subject` | e.g. `Science`. Spell it the same way every time: stats are grouped by it. |
   | `type` | `choice` (multiple choice) or `typed` (the player types the answer, good for math) |
   | `prompt` | The question |
   | `choice_a` … `choice_d` | 2–4 choices, filled from `choice_a` with no gaps. Leave empty for `typed`. |
   | `answer` | `choice`: the letter of the right choice (`A`–`D`). `typed`: the answer itself. |
   | `accepted` | `typed` only: other answers to accept, separated by `;` (e.g. `twelve;12.0`) |
   | `source` | Optional: where you found the question |

2. **File → Download → Comma-separated values (.csv)** in Google Sheets, or **Save As → CSV
   UTF-8** in Excel, and save it as `data/questions.csv` (create the `data` folder if you
   don't have one). The folder is gitignored, so your questions stay private.
3. Load it:

   ```bash
   npm run import                        # reads data/questions.csv
   npm run import -- path/to/other.csv   # or any other file
   ```

The whole file is checked first. If anything is wrong, every problem is listed with its
line number and **nothing** is imported, so fix the spreadsheet and run it again. Re-running
the import is safe: questions are matched by `id`, edited rows are updated, and questions
you remove from the file are switched off (their old answers stay in the stats).

Until you do this, the bot loads 20 placeholder questions (`questions/sample.csv`) so you
can try it out. Importing your own switches them off.

### 6. Start the bot

```bash
npm run dev     # auto-restarts on file changes
# or
npm start       # plain "node app.js"
```

You should see `Logged in as <your bot's name>`. If `DISCORD_TOKEN` is missing it exits
straight away with a message saying so.

### 7. Invite the bot

Under **Installation** (or **OAuth2 → URL Generator**), select the `bot` and
`applications.commands` scopes, give the bot permission to view and send messages in the
channels you'll play in, open the generated URL, and add it to a server you can test in.

Then type `/start` in a channel the bot can see.

## How a solo game works

1. `/start` is a private (ephemeral) setup: pick **Are You Smarter Than a Fifth Grader**,
   **Confirm**, choose **Solo**, then a difficulty:

   | | Hard | Standard | Casual |
   | --- | --- | --- | --- |
   | Lives | 1 (the first miss ends the run) | 3 | unlimited |
   | Cheats | none | 1 per run | unlimited |
   | Stats | count, plus a Hard section | count | saved but don't count |

   **Cheats** (shown under each question while you have some left, each usable once per
   question):

   - 👀 **Peek**: privately shows how other players answered this question (it needs at least
     5 earlier answers).
   - ✂️ **50/50**: crosses out wrong choices until two are left (multiple choice only).
   - 🔄 **Swap**: replaces the question with another from the same tile.
   - ⏱️ **Extra time**: adds more time to the clock.
2. The bot posts the **board** in the channel: two tiles per grade, like "3rd · Science".
   Only the lowest grade you haven't finished is playable, so you climb from 1st to 5th.
   Only you can press the buttons in your game, and only one game can run per channel.
3. Pick a tile and a question appears with a countdown. Multiple-choice questions have
   **A–D** buttons (shuffled every time); typed questions have an **Answer** button that
   opens a text box. Running out of time counts as a miss.
4. The result replaces the question, then a fresh board appears. Misses cost lives.
5. The run ends when you clear the board, run out of lives, press **Quit**, or leave the
   board alone for 5 minutes. The bot posts a summary of how it went.

Timings and difficulties live in `constants.js`.

## How a trivia night works

A host runs the night for a group, usually with everyone in a voice call while the host reads
the questions aloud (the bot posts them too).

1. `/start` → pick the game → **Confirm** → **Trivia night**. The bot posts a sign-up in the
   channel. Players press **Join** (up to 25; **Leave** if you change your mind). The host
   doesn't have to play.
2. The host presses **Make teams**. A private team builder appears for the host only:
   - pick **2, 3 or 4 teams** (🟥 Red, 🟦 Blue, 🟩 Green, 🟨 Yellow); players are dealt out at
     random,
   - **Shuffle** to deal again, or **Move a player** to put someone on a different team,
   - **Back** reopens sign-up if someone's missing, and **Start** begins the night.
3. A **board** appears, like in solo. Teams take turns choosing the tile: the picking team's
   current answerer chooses (the host can choose for them if they're away).
4. The question appears **for every team at once**. Each team has one **answerer** at a time,
   going through the team in alphabetical order, one question each. Only they can answer,
   and they do it privately (you see "🔒 Locked in", everyone else only sees that your team
   has answered). Teammates don't get a say.
5. Each team can use **🙋 Ask a teammate** once per night: the answerer picks a teammate who
   answers that one question instead.
6. When every team has answered (or time runs out; a team that didn't answer gets nothing),
   the bot shows the answer, what each team said, and the scores. The host presses **Next ▶**
   for the next tile, or **Play another board** once a board is finished.
7. The host presses **End night** to finish. The team with the most correct answers wins
   (ties share the win).

Every answer counts toward each player's own stats, and trivia nights also get their own
section in `/stats` (nights played, team wins and so on).

## Stats

Every guess is saved, so there is a lot to look at. `/stats` shows a player's numbers:

- `/stats` shows your own, privately. `/stats user:@someone` shows theirs.
  `/stats share:true` posts it in the channel instead.
- It covers questions answered, % correct and average answer time overall, by grade and by
  subject, plus your Standard and Hard runs (how many, how many you cleared, your best) and
  your trivia nights.
- **Casual games don't count**, and a timeout counts as a wrong answer.

If you updated from an earlier version, run `npm run register` again so Discord learns about
`/stats`.

## Project layout

| File | What it's for |
| --- | --- |
| `app.js` | Opens the database, creates the discord.js client, logs in to the gateway, and hands every interaction to `flow.js`. |
| `flow.js` | Routes every command, button and pop-up, and runs the private `/start` setup screens. |
| `solo.js` | A solo game: the board, questions, answers, lives, timers and the summary. |
| `night.js`, `teams.js` | A trivia night: sign-up, team builder, rounds, results; and the team rules (dealing, answer order, winners). |
| `board.js` | Builds the grade + subject board and draws it as buttons. |
| `ui.js`, `messages.js` | Build the message text and buttons, and send / edit / delete messages in the channel. |
| `answers.js` | Checks typed answers (ignoring case and punctuation, comparing numbers as numbers). |
| `cheats.js` | The rules for Peek, 50/50, Swap and Extra time. |
| `commands.js` | Defines and registers the slash commands. |
| `constants.js` | The packs, difficulties, timings and the button ID scheme. |
| `state.js` | In-memory store of games in progress. Not persisted — restarting the bot clears them. |
| `utils.js` | Small helpers for the Discord REST API (used to register commands). |
| `db.js` | Opens the SQLite database and applies schema migrations. |
| `records.js` | Saves players, games, questions asked, guesses and cheat uses. |
| `stats.js` | The stats queries and the text of `/stats`. |
| `importer.js`, `csv.js` | Check a question CSV and load it into the database. |
| `questions.js` | Looks questions up in the database. |
| `rng.js` | All randomness, so tests can make it predictable. |
| `questions/sample.csv` | 20 placeholder questions used when you haven't imported your own. |
| `scripts/import-questions.js` | `npm run import`: loads your question CSV. |
| `scripts/smoke.js`, `scripts/fakes.js`, `scripts/testdata.js` | Plays whole games locally against a fake Discord (`node scripts/smoke.js`), with helpers for test data. |
| `test/` | Unit tests (`npm test` runs these and the smoke test). |
| `AGENTS.md` | Guide for coding agents: architecture, conventions, rules, and what's planned next. |
| `DESIGN.md` | The planned design (solo boards, trivia nights, stats, database) and the build plan. |

## Working with `.env`

`.env` holds live credentials — the bot token especially. Treat it as off-limits:

- **Don't read, open, print, copy, or edit `.env`** unless you are the person setting up
  your own local copy. Tools and assistants working in this repo should leave it untouched
  and get any values they need from the person running the bot.
- **If anything reads from or writes to `.env`** — a script, an editor, an assistant, a
  command you didn't expect — **report it** so it can be checked. Accessing that file is
  never a routine step.
- Only `.env.sample` (placeholders, no real values) belongs in version control. `.env` is
  gitignored; keep it that way.

## Notes

- Games in progress live in memory, so restarting the bot abandons them (they're marked
  abandoned in the database). Every game and guess is saved to `data/trivia.db` as it
  happens.
- Only one game can run in a channel at a time.
- It's only online while the process is running. For 24/7 use, run it under a process
  manager (e.g. pm2) on a machine that stays awake.
