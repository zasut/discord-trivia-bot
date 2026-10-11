# Discord Trivia Bot

A Discord bot for running trivia games in a channel. You start a session with `/start`, pick
a game mode, open a lobby, and the bot walks everyone through the questions with a timer on
each one.

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

This installs `/start` globally for your app. Re-run it whenever you change `commands.js`.
Global commands can take a few minutes to appear in clients the first time.

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
`applications.commands` scopes, give the bot permission to send messages, open the generated
URL, and add it to a server you can test in.

Then type `/start` in any channel.

## How the round works

1. `/start` — a private (ephemeral) prompt asking which game mode you want.
2. Pick **Are You Smarter Than a Fifth Grader** → a confirmation screen with **Confirm** /
   **Back**.
3. Confirm → a **Solo or teams?** screen. Solo continues; the Teams button is a placeholder
   for now.
4. Solo → the bot posts a public message in the channel with a ~60-second countdown and
   **Start Now** / **Cancel**. When the countdown ends (or someone hits Start Now), the
   questions begin.
5. Each question shows **Yes** / **No** and gives you 10 seconds. You get told whether you
   were right; if the timer runs out it reveals the answer and moves on.
6. After the last question the bot posts your score and ends the session.

Timings live in `constants.js` (`LOBBY_COUNTDOWN_MS`, `QUESTION_TIMEOUT_MS`).

## Project layout

| File | What it's for |
| --- | --- |
| `app.js` | Creates the discord.js client, logs in to the gateway, and hands every interaction to `flow.js`. |
| `flow.js` | All the game logic — every screen, the question loop, and the per-question / countdown timers. |
| `commands.js` | Defines and registers the `/start` command. |
| `constants.js` | Button ID scheme, the mode list, and the timing constants. |
| `state.js` | In-memory store of active sessions. Not persisted — restarting the bot clears everything. |
| `trivia.js` | Loads the questions and checks answers. |
| `utils.js` | Small helpers for the Discord REST API (used to register commands). |
| `db.js` | Opens the SQLite database and applies schema migrations. |
| `records.js` | Saves players, games, questions asked, guesses and cheat uses. |
| `importer.js`, `csv.js` | Check a question CSV and load it into the database. |
| `questions.js` | Looks questions up in the database. |
| `rng.js` | All randomness, so tests can make it predictable. |
| `questions/aystafg.json` | The current question set (Are You Smarter Than A Fifth Grader). |
| `questions/sample.csv` | 20 placeholder questions used when you haven't imported your own. |
| `scripts/import-questions.js` | `npm run import`: loads your question CSV. |
| `scripts/smoke.js` | Runs the whole flow locally with a fake Discord client (`node scripts/smoke.js`). Handy after changing `flow.js`. |
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

- The bot keeps games in progress in memory. Restarting it abandons any session in progress.
- It assumes one trivia session per channel at a time.
- It's only online while the process is running. For 24/7 use, run it under a process
  manager (e.g. pm2) on a machine that stays awake.
