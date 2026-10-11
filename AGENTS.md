# AGENTS.md

Guide for coding agents working in this repo. Human setup and run steps (Developer Portal,
`.env`, inviting the bot) are in [README.md](README.md). This file covers how the code
works today and how to change it safely. The planned design and the build plan to get
there are in [DESIGN.md](DESIGN.md).

## Project

A Discord trivia bot built on **discord.js v14** as a **gateway bot**. It keeps a websocket
open to Discord, so there is no HTTP server, tunnel or public URL. The only playable mode is
**"Are You Smarter Than a Fifth Grader"**, solo only. `/start` takes one user through a
private (ephemeral) setup, posts a public lobby with a countdown, asks timed yes/no
questions and then posts the score.

- Node.js ≥ 18, ES modules (`"type": "module"`), plain JavaScript.
- Dependencies: `discord.js`, `dotenv`. Dev: `nodemon`.
- No build step, linter, formatter config or test framework. Match the style of the
  surrounding code (2-space indent, single quotes, semicolons, trailing commas).

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install dependencies. |
| `node scripts/smoke.js` | Offline end-to-end test that uses a fake Discord client. Needs no credentials. **This is how you verify a change.** |
| `npm start` / `npm run dev` | Run the bot (`node app.js` / nodemon). Logs in with the real token from `.env`. |
| `npm run register` | Bulk-overwrites the app's **global** slash commands on Discord with `commands.js`. |

`npm start`, `npm run dev` and `npm run register` use the user's live Discord app. Agents
can't click buttons in Discord, so leave live runs and command registration to the user
unless they ask.

## Rules

- **`.env` is off-limits.** It holds the live bot token. Never read, open, print, copy or
  edit it, and never run anything that would print its contents. If you need a value from
  it, ask the user. If you notice anything reading or writing `.env` unexpectedly (a
  script, a tool, a command), report it. Only `.env.sample` (placeholders) is tracked, and
  `.env` must stay gitignored.
- **Smoke test is mandatory.** Run `node scripts/smoke.js` after any change to `flow.js`,
  `state.js`, `constants.js` or `trivia.js`, and report the result. When you add a screen,
  button or command, extend `scripts/smoke.js` to drive it.
- **`data/` is off-limits too.** Once it exists, it holds the user's private question bank
  and real stats. Never read or modify it unless asked. Tests use `:memory:` or a temp
  directory.
- **No commits unless asked.** Don't `git commit` or `git push` unless the user explicitly
  asks. Working through DESIGN.md's build plan counts as asking for one commit per phase.
- **Commit messages** are one short line in the imperative, e.g.
  `Add solo board game with difficulties`. No body, and no AI attribution (no
  `Co-Authored-By` trailer, no "Generated with" footer).
- **Ask before adding npm dependencies.** The DESIGN.md plan needs none: it uses Node
  built-ins (`node:sqlite`, `node:test`).
- **Keep this file in sync.** When you change the custom_id scheme, slash commands, session
  shape, tunables or file layout, update the matching section here in the same change.
  When a DESIGN.md phase lands, tick it there too.

## Files

| File | Role |
|---|---|
| `app.js` | Thin shell. Creates the discord.js `Client` (intent `Guilds` only), logs in and forwards every `InteractionCreate` to `handleInteraction`. If a handler throws, it sends the user an ephemeral error notice. |
| `flow.js` | All game logic: the `handleInteraction` entry point, the per-button `handleComponent` switch, payload builders (`button`, `row`, `*Components`), channel helpers and the game loop. |
| `constants.js` | Tunables, `MODES`, the `cid.*` custom_id builders and `parseCustomId`. |
| `state.js` | In-memory session `Map` keyed by `sid`, plus timer-handle helpers. |
| `trivia.js` | Loads `questions/aystafg.json` at import time. Exports `getQuestions`, `getQuestion(i)`, `checkAnswer(q, value)` and `QUESTION_COUNT`. |
| `commands.js` | Slash-command definitions. Running it (`npm run register`) pushes them to Discord. |
| `utils.js` | `DiscordRequest` / `InstallGlobalCommands` (REST), used only by `commands.js`. The running bot doesn't use this file. `getRandomEmoji` and `capitalize` are unused leftovers from the Discord example-app template. |
| `questions/aystafg.json` | Question bank. "aystafg" = **A**re **Y**ou **S**marter **T**han **A** **F**ifth **G**rader. |
| `scripts/smoke.js` | Offline end-to-end test (see Commands). |
| `DESIGN.md` | The agreed design (question bank, solo, trivia night, stats, database) and the phased build plan. |

## Interaction flow

1. **`/start`** creates the session and replies (ephemeral) with *"Which trivia game
   mode?"*: one button per `MODES` entry, with disabled modes shown disabled.
2. **Mode button** updates to *"You've selected: **&lt;label&gt;**"* with **Confirm** /
   **Back**.
3. **Confirm** updates to *"Solo or teams?"* with **Solo** / **Teams** / **Back**. Teams is
   a placeholder that re-shows this screen with a "coming soon" note.
4. **Solo** updates the ephemeral message to *"Lobby posted in the channel 👇"*, then sends
   a public lobby: *"**Are You Smarter Than a Fifth Grader** — starting `<t:UNIX:R>`"* with
   **Start Now** / **Cancel**, and arms a `LOBBY_COUNTDOWN_MS` timer.
   - **Start Now** (`deferUpdate`) or the timer starts the questions.
   - **Cancel** (`update`) edits the lobby to "Trivia cancelled." and deletes the session.
5. **Questions.** Q1 edits the lobby message in place. Every later question is a fresh
   channel message. Each has **Yes** / **No** and a `QUESTION_TIMEOUT_MS` timer.
   - An answer `update`s the message to *"You answered **yes** — ✅ Correct!"* or
     *"❌ Incorrect."*
   - A timeout edits the message to *"⏰ Time's up! The answer was **&lt;answer&gt;**."*
   - After `RESULT_READ_MS` the next question is posted.
6. **Completion** sends *"🏁 Trivia complete! You got **X/N** correct."* and deletes the
   session. Nothing is persisted.

A button whose `sid` has no live session (bot restarted, game already over) gets an
ephemeral *"That trivia session expired — run `/start` again."*

Code path: `handleInteraction` → `handleComponent` (switch on `kind`) → `startQuestions` →
`showQuestion` (Q1, edit) / `postQuestion` (Q2+, send) → `advance`, with
`onQuestionTimeout` fired by the question timer.

## Replying to Discord

- **Acknowledge every interaction exactly once, within ~3 seconds**, with `reply`, `update`
  or `deferUpdate`. Acknowledge first and do slow work (posting the lobby, advancing
  questions) afterwards.
- **Ephemeral screens:** open with `interaction.reply({ flags: MessageFlags.Ephemeral, ... })`,
  then move between screens with `interaction.update(...)`, which keeps the message
  ephemeral.
- **Public messages** (lobby, questions, completion) are sent and edited through the
  channel by id, using `sendMessage` / `editMessage` in `flow.js`
  (`client.channels.fetch(id)` → `send` / `messages.edit`). This is because timer callbacks
  have no interaction to reply with. The session stores `channelId` and `messageId` (the
  current public message) for this.
- A button on a public message (Cancel, Yes/No) edits that same message with
  `interaction.update`.
- **Message format** is classic `{ content, components }`, with action rows built by
  `button()` / `row()`. Components V2 is deliberately not used.
- **Countdowns** use Discord's `<t:UNIX:R>` timestamp, which counts down on the client.
  Never poll-edit a message to show a countdown.
- **Discord setup:** the Developer Portal's *Interactions Endpoint URL* must stay
  **empty**. If it is set, Discord sends interactions there instead of to the gateway and
  every command fails. The bot needs no privileged intents.

## custom_id scheme

The custom_id is both the router key and the only state a button carries. Build ids only
with `cid.*` and parse them only with `parseCustomId`. Both live in `constants.js`.

| `kind` | custom_id | Extra fields |
|---|---|---|
| `modeSelect` | `mode_select_<key>_<sid>` | `key` |
| `modeConfirm` | `mode_confirm_<sid>` | — |
| `modeBack` | `mode_back_<sid>` | — |
| `soloSelect` | `party_solo_<sid>` | — |
| `teamsSelect` | `party_teams_<sid>` | — |
| `partyBack` | `party_back_<sid>` | — |
| `lobbyStart` | `lobby_start_<sid>` | — |
| `lobbyCancel` | `lobby_cancel_<sid>` | — |
| `answer` | `answer_<sid>_<qIndex>_<value>` | `qIndex` (number), `value` (`'yes'` / `'no'`) |
| `unknown` | anything else | `raw` |

- `sid` is `crypto.randomUUID()` with the dashes stripped: 32 hex characters and **no
  underscores**, so ids split cleanly on `_`. Keep it that way.
- `parseCustomId` splits `mode_select_` ids from the right, so a mode key may contain
  underscores. The parts of an `answer` id may not.
- Discord limits a custom_id to 100 characters.
- **Never put anything in a custom_id that reveals the correct answer.** Players can read
  custom_ids in their client. DESIGN.md moves to a new `<kind>:<sid>[:<arg>…]` scheme in
  Phase 2.

**Adding a button:** add a builder to `cid`, a branch in `parseCustomId` (and update the
kind list in the comment above it), a `case` in `handleComponent`, a row in the table
above and a step in `scripts/smoke.js`.

## Sessions and timers

Created by `createSession` in `state.js`:

```js
{
  sid, hostId, channelId,
  mode: null,          // MODES key once picked
  party: null,         // 'solo' | 'teams' once picked (only 'solo' is ever set today)
  players: [hostId],   // only the host for now
  status: 'picking',   // 'picking' | 'lobby' | 'in_progress' | 'complete'
  questionIndex: 0,
  answers: [],         // { qIndex, value, correct, timedOut? }
  messageId: null,     // current public lobby / question message
  timer: null,         // the single active setTimeout handle
  createdAt,
}
```

`state.js` also lists a `'cancelled'` status, but nothing sets it: Cancel deletes the
session instead.

- **All state is in memory.** A restart drops every session. The bot assumes one process
  and one active session per channel, but nothing enforces the latter.
- **One timer per session.** Always arm timers with `armTimer` (`flow.js`). It `unref()`s
  the handle and stores it with `setTimer`, which clears any previous timer.
  `clearTimer` / `deleteSession` cancel it. Timer callbacks must `.catch` their promise,
  because there is no interaction to report errors to.
- **Race rule:** a click and a timer can both fire for the same question. Change session
  state (record the answer, clear the timer) **before the first `await`** in a handler.
  Both the answer handler and `onQuestionTimeout` check three guards before acting:
  `status === 'in_progress'`, `qIndex === session.questionIndex`, and no recorded answer
  for that `qIndex`. Stale or duplicate clicks get a `deferUpdate` and change nothing. Any
  new timed step needs the same guards.
- Channel send/edit failures are caught and logged so the game loop keeps going.

## Questions and tunables

- `questions/aystafg.json` is an array of `{ id, prompt, answer }`. `answer` is lowercase
  `"yes"` or `"no"`, and `checkAnswer` does a strict string compare against the button
  value.
- Questions are asked in file order, all of them: `QUESTION_COUNT` is the length of the
  file. The file is read once at import time, so the bot must be restarted to pick up
  edits.
- The two current questions are throwaway placeholders that exercise the correct and
  incorrect paths.

| Tunable | Where | Value |
|---|---|---|
| `QUESTION_TIMEOUT_MS` | `constants.js` | `10_000`: answer window per question |
| `LOBBY_COUNTDOWN_MS` | `constants.js` | `60_000`: lobby countdown before questions auto-start |
| `MODES` | `constants.js` | `fifthgrader` (enabled), `trivia2` "Coming Soon" (disabled) |
| `RESULT_READ_MS` | `flow.js` | `1500`: pause after a result before the next question |

## Slash commands

`/start` is the only command. It is defined in `commands.js` with `type: 1`,
`integration_types: [0, 1]` (guild and user install) and `contexts: [0, 1, 2]` (guild, bot
DM, private channel).

**Adding a command:** define it in `commands.js`, add it to `ALL_COMMANDS`, handle its
`interaction.commandName` in `handleInteraction` and add a step to `scripts/smoke.js`. Then
tell the user to run `npm run register`. Global commands can take a few minutes to appear.

## Known gaps

- Anyone can press Start Now, Cancel or answer. These spots are marked
  `// TODO: host-only?` in `flow.js`.
- Sessions abandoned during setup are never cleaned up until the bot restarts.
- Public messages are sent as the bot, so they only work in channels the bot can access.
  If the lobby send fails, the error is logged but the user has already been told
  "Lobby posted".
- The smoke test only covers the happy path. It does not exercise timeouts, Cancel, Back,
  Teams or disabled modes.

## Roadmap

The full design and build plan are in [DESIGN.md](DESIGN.md). It is the spec, so follow it,
and record any judgment call in its Decisions log. The phases, in order:

1. **Database and question import:** SQLite via `node:sqlite`, CSV import of the private
   question bank, bundled sample questions.
2. **Solo board game:** a Fifth Grader grade + subject board, multiple choice and typed
   answers, Hard / Standard / Casual difficulties, and every guess recorded.
3. **Cheats:** Peek, 50/50, Swap, Extra time.
4. **Stats:** `/stats`.
5. **Trivia night:** sign-up, teams, rotating answerers, Ask a teammate, host controls.
6. **Leaderboard and analysis:** `/leaderboard` and saved SQL queries.

The sections above describe the code before Phase 1. Update them as each phase lands.
