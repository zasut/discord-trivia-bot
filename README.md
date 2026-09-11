# Discord Trivia Bot

A Discord bot for running trivia games in a channel. You start a session with `/start`, pick
a game mode, open a lobby, and the bot walks everyone through the questions with a timer on
each one.

This is an **HTTP interactions** bot. It doesn't hold a gateway connection, so it won't show
a green "online" dot in the member list — that's normal. Discord reaches it by sending
signed HTTPS requests to an endpoint you configure, which is why local development needs a
tunnel (see below).

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- A Discord application — create one at <https://discord.com/developers/applications>
- A way to expose your local server to the internet during development:
  [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (no account needed) or [`ngrok`](https://ngrok.com/)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your Discord app

In the [Developer Portal](https://discord.com/developers/applications), create an
application, then add a bot to it (**Bot** tab). You'll need three values:

| Where to find it | Goes in `.env` as |
| --- | --- |
| General Information → **Application ID** | `APP_ID` |
| General Information → **Public Key** | `PUBLIC_KEY` |
| Bot → **Reset Token** (shown once) | `DISCORD_TOKEN` |

### 3. Fill in `.env`

Copy the sample and put your three values in it:

```bash
cp .env.sample .env
```

```
APP_ID=your-application-id
DISCORD_TOKEN=your-bot-token
PUBLIC_KEY=your-public-key
```

`.env` is gitignored and must never be committed. See [Working with `.env`](#working-with-env)
below.

### 4. Register the slash command

```bash
npm run register
```

This installs `/start` globally for your app. Re-run it whenever you change `commands.js`.
Global commands can take a few minutes to appear in clients the first time.

### 5. Start the server

```bash
npm run dev     # auto-restarts on file changes
# or
npm start       # plain "node app.js"
```

You should see `Listening on port 3000`. (If `PUBLIC_KEY` is missing or empty the server
won't start — that's a safeguard in the Discord library.)

### 6. Expose it and point Discord at it

In a second terminal, open a tunnel to port 3000:

```bash
cloudflared tunnel --url http://localhost:3000
# or:  ngrok http 3000
```

Copy the `https://…` URL it prints. In the Developer Portal, go to
**General Information → Interactions Endpoint URL** and set it to that URL with
`/interactions` on the end, e.g.:

```
https://your-tunnel-subdomain.trycloudflare.com/interactions
```

Click **Save Changes**. Discord sends a signed test request; if the server is running and
`PUBLIC_KEY` is correct, it saves. If it won't save, double-check the `/interactions` path
and that `PUBLIC_KEY` matches the portal exactly.

The free tunnels hand out a new URL each time they start, so you'll usually re-paste this
after restarting the tunnel.

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
| `app.js` | Express server and the `/interactions` endpoint. Verifies the request, hands it to `flow.js`, sends the reply. |
| `flow.js` | All the game logic — every screen, the question loop, and the per-question / countdown timers. |
| `commands.js` | Defines and registers the `/start` command. |
| `constants.js` | Button ID scheme, the mode list, and the timing constants. |
| `state.js` | In-memory store of active sessions. Not persisted — restarting the server clears everything. |
| `trivia.js` | Loads the questions and checks answers. |
| `utils.js` | Small helpers for talking to the Discord REST API. |
| `questions/aystafg.json` | The current question set (Are You Smarter Than A Fifth Grader). |
| `scripts/smoke.js` | Runs the whole flow locally without Discord (`node scripts/smoke.js`). Handy after changing `flow.js`. |
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
- It's an HTTP-interactions app: no gateway connection, so it stays "offline" in the member
  list and only acts when Discord calls the `/interactions` endpoint.
