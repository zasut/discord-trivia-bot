# Discord Trivia Bot

A Discord bot for running trivia games in a channel. You start a session with `/start`, pick
a game mode, open a lobby, and the bot walks everyone through the questions with a timer on
each one.

This is a **gateway** bot built on [discord.js](https://discord.js.org/). It connects out to
Discord over a websocket, so it shows as online in the member list and there is no public
URL, tunnel, or endpoint to configure — `npm start` is all it takes to run it.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
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

### 5. Start the bot

```bash
npm run dev     # auto-restarts on file changes
# or
npm start       # plain "node app.js"
```

You should see `Logged in as <your bot's name>`. If `DISCORD_TOKEN` is missing it exits
straight away with a message saying so.

### 6. Invite the bot

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
| `questions/aystafg.json` | The current question set (Are You Smarter Than A Fifth Grader). |
| `scripts/smoke.js` | Runs the whole flow locally with a fake Discord client (`node scripts/smoke.js`). Handy after changing `flow.js`. |
| `CONTEXT.md` | Design notes and what's planned next. |

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

- The bot keeps all state in memory. Restarting it abandons any session in progress.
- It assumes one trivia session per channel at a time.
- It's only online while the process is running. For 24/7 use, run it under a process
  manager (e.g. pm2) on a machine that stays awake.
