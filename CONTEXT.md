# Discord Trivia Bot — Project Context

> **Read this first.** Source of truth for anyone (human or agent) working on this bot. It
> records what is built, how it is wired, and what is deferred. Keep it in sync with the
> code.

---

## 0. Status — walking-skeleton MVP

**Built and verified live on 2026-09-10 (as an HTTP-interactions bot; since migrated to a
discord.js gateway bot, see §1).** A single user can run `/start`, pick the game
mode, pass both confirmation screens, land in the public lobby, and play both questions to
completion. Also covered by an offline test: `node scripts/smoke.js` (fake discord.js
client, drives the whole flow, asserts the reply method at each step and the channel
sends/edits).

### What the MVP does (implemented)

1. **`/start`** — ephemeral reply: *"Which trivia game mode?"* + one button per `MODES`
   entry. Only **"Are You Smarter Than a Fifth Grader"** is enabled; the other
   (`Coming Soon`) is rendered `disabled`.
2. **Pick a mode** → edits the same ephemeral message to *"You've selected: **&lt;label&gt;**"* +
   **Confirm** / **Back**.
3. **Confirm** → edits to *"Solo or teams?"* + **Solo** / **Teams** / **Back**.
   - **Teams** is a no-op this sprint — the button works but just re-shows the screen with
     "Teams mode is coming soon — pick Solo for now."
4. **Solo** → the ephemeral message becomes *"Lobby posted in the channel 👇"*, and the bot
   posts a **public** channel message: *"**Are You Smarter Than a Fifth Grader** — starting
   `<t:UNIX:R>`"* (Discord renders that timestamp as a live client-side countdown, ~60s)
   with **Start Now** / **Cancel** buttons. A `setTimeout(LOBBY_COUNTDOWN_MS)` is armed.
   - **Start Now** → clears the timer, starts the questions immediately.
   - **Cancel** → clears the timer, edits the public message to "Trivia cancelled.", drops
     the session.
   - Timer fires → questions start automatically.
5. **Question loop** — 2 questions from `questions/aystafg.json`. Each is yes/no,
   shown as **Yes** / **No** buttons, with a `setTimeout(QUESTION_TIMEOUT_MS)` (10s) per
   question.
   - Answer clicked → clears the timer, message is edited to
     *"You answered **yes** — ✅ Correct!"* / *"❌ Incorrect."*, then advances after a short
     pause.
   - Timer expires with no answer → message edited to *"⏰ Time's up! The answer was
     **&lt;answer&gt;**."*, then advances.
   - Question 1 **edits the lobby message in place**; every later question is a **fresh
     channel message** (reads better in the channel history).
6. **Completion** — after the last question the bot posts *"🏁 Trivia complete! You got
   **X/2** correct."* and deletes the session. No scores are stored.

### Tunables (`constants.js`)

| Constant | Value | Meaning |
|---|---|---|
| `QUESTION_TIMEOUT_MS` | `10_000` | answer window per question |
| `LOBBY_COUNTDOWN_MS` | `60_000` | public lobby countdown before questions auto-start |
| `MODES` | 2 entries | `fifthgrader` (enabled), `trivia2` "Coming Soon" (disabled) |

### Implementation notes

- **Message style is classic** `{ content, components }` (string + action rows) everywhere.
  Components V2 / `TEXT_DISPLAY` is deliberately not used — simpler.
- **Ephemeral** screens (mode picker / confirm / solo-teams) are opened with
  `interaction.reply({ flags: MessageFlags.Ephemeral })` and then edited in place with
  `interaction.update(...)` (an update keeps the message ephemeral).
- **Public messages** (lobby, questions, completion) are posted / edited **by channel id**
  through the discord.js client, not through an interaction:
  - create: `client.channels.fetch(channelId)` → `channel.send(payload)`
  - edit: `channel.messages.edit(messageId, payload)`
  The session stores `channelId` + `messageId` so timer callbacks can post/edit without an
  interaction in hand. Buttons on a public message (Cancel, Yes/No) edit it directly with
  `interaction.update(...)`.
- **Timers** are `setTimeout` handles kept on the session (`state.js` `setTimer` /
  `clearTimer`). Callbacks are re-guarded (`status === 'in_progress'`, `qIndex` matches,
  no existing answer for that `qIndex`) so a late click + a firing timeout can't
  double-advance. Session state is always mutated **before** the first `await` in a
  handler for the same reason. Handles are `.unref()`'d so a pending timer never holds the
  process open on its own (the gateway connection does that).
- **All state is in-memory** (`state.js`, a `Map` keyed by `sid`). Lost on restart. Assumes
  one process and, in practice, one active session per channel.
- **`sid`** = `crypto.randomUUID()` with dashes stripped (32 hex chars, no underscores) so
  `answer_<sid>_<qIndex>_<value>` splits cleanly on `_`.

### Deferred (not built yet)

Scoreboard + persistence · Markdown question bank + parser · real Teams mode · multiple
concurrent sessions per channel · `/scoreboard`, `/stop`, `/settings` · host-only
permission checks on lobby/answer buttons · shuffling / question count / scoring tuning ·
real fifth-grade questions (current file is 2 throwaway yes/no items for flow testing).

---

## 1. Goal

A Discord bot that runs trivia games in a channel. The first and only real game mode is
**"Are You Smarter Than a Fifth Grader"**; other modes appear as buttons but are out of
scope.

Questions are loaded from a file, not hard-coded. **MVP: a JSON file** (`§7`). **Later: a
Markdown question bank** (`§7 Later`).

This is a **gateway bot** (discord.js). It holds a websocket connection to Discord, shows
online, and needs no public URL or tunnel — `npm start` is the whole run procedure. It was
an HTTP-interactions bot (Express + signed POSTs to `/interactions`) until the gateway
migration; the tunnel / Interactions Endpoint URL step was the main dev-time pain point,
and live Teams play (§9) suits a persistent connection better. The Interactions Endpoint
URL in the Developer Portal **must stay empty**, otherwise Discord routes interactions
there instead of the gateway.

---

## 2. Architecture

### Request path

```
Discord ══gateway websocket══▶ app.js   (discord.js Client, intents: Guilds)
                                 │  Events.InteractionCreate
                                 ▼
                               flow.js  handleInteraction(interaction)
                                 │
        replies via the interaction ─▶ interaction.reply / update / deferUpdate
        bot-initiated messages      ─▶ client.channels.fetch(id) → send / messages.edit
```

- **Each interaction must be acknowledged within ~3s** (`reply`, `update` or
  `deferUpdate`). Handlers acknowledge first and do the slower follow-up work (posting the
  lobby, advancing questions) afterwards.
- `app.js` catches handler errors and sends the user a short ephemeral notice rather than
  leaving them on "interaction failed".
- `utils.js` `DiscordRequest` / `InstallGlobalCommands` remain only for
  `npm run register` (`commands.js`); the running bot doesn't use them.

### Discord mechanics used

- **Ephemeral** = `MessageFlags.Ephemeral`; only the invoking user sees it.
- **`custom_id` is the router key and carries state** — every id ends with `_<sid>`.
  `parseCustomId` (`constants.js`) turns an id into `{ kind, sid, ...extra }` (table in §6).
- **User id**: `interaction.user.id` (discord.js resolves guild vs. DM for us).
- **Edit a channel message the bot posted**: `channel.messages.edit(messageId, payload)`.
- **`<t:UNIX:R>`** in message content renders as a live, client-side relative countdown —
  used for the lobby so the bot never has to poll-edit the message.
- **Intents**: only `Guilds`. Slash commands and button clicks need no privileged intents.

---

## 3. Tech stack

- **Node.js ≥ 18**, ES modules (`"type": "module"`).
- **discord.js@^14** — gateway client, interaction replies, channel send/edit.
- **dotenv** — loads `.env` (`APP_ID`, `DISCORD_TOKEN`).
- **nodemon** (dev) — `npm run dev`.
- No question-parser dependency — the MVP reads JSON with `fs.readFileSync` + `JSON.parse`.

Running it end to end (credentials, `npm run register`, `npm start`, invite) is covered
step by step in the README.

---

## 4. File layout

```
discord-trivia-bot/
├── CONTEXT.md              -> this file
├── README.md               -> setup / run instructions
├── package.json
├── package-lock.json
├── .env.sample             -> APP_ID / DISCORD_TOKEN (placeholders)
├── .gitignore              -> node_modules, .env
├── app.js                  -> thin gateway shell: discord.js Client -> handleInteraction(interaction)
├── flow.js                 -> handleInteraction() + all screen handlers + timer helpers
├── commands.js             -> registers the /start command
├── constants.js            -> cid.* builders, parseCustomId, MODES, *_MS tunables
├── state.js                -> in-memory session Map + timer handles
├── trivia.js               -> loads questions/aystafg.json, getQuestion, checkAnswer
├── utils.js                -> DiscordRequest, InstallGlobalCommands, small helpers
├── questions/
│   └── aystafg.json        -> [{ id, prompt, answer }]  (answer: "yes" | "no")
│                              "aystafg" = Are You Smarter Than A Fifth Grader
└── scripts/
    └── smoke.js            -> offline end-to-end test w/ fake client (node scripts/smoke.js)
```

Not created yet (future sprints): `scoreboard.js`, `data/scoreboard.json`,
`questions/*.md`.

---

## 5. Slash commands

| Command | Status | Notes |
|---|---|---|
| `/start` | **implemented** | Opens the ephemeral game-mode picker. Payload: `{ name, description, type: 1, integration_types: [0,1], contexts: [0,1,2] }`. Re-run `npm run register` after editing `commands.js`. |
| `/scoreboard` | planned | Render overall + per-mode standings. |
| `/stop`, `/settings` | planned | Cancel a session / configure teams etc. |

---

## 6. Interaction flow (as built)

`sid` is created in `/start` and threaded through every `custom_id`. `parseCustomId`
returns one of these `kind`s:

| `kind` | from `custom_id` | extra |
|---|---|---|
| `modeSelect` | `mode_select_<key>_<sid>` | `key` |
| `modeConfirm` | `mode_confirm_<sid>` | — |
| `modeBack` | `mode_back_<sid>` | — |
| `soloSelect` | `party_solo_<sid>` | — |
| `teamsSelect` | `party_teams_<sid>` | — |
| `partyBack` | `party_back_<sid>` | — |
| `lobbyStart` | `lobby_start_<sid>` | — |
| `lobbyCancel` | `lobby_cancel_<sid>` | — |
| `answer` | `answer_<sid>_<qIndex>_<value>` | `qIndex` (number), `value` (`'yes'`/`'no'`) |
| `unknown` | anything else | `raw` |

Session object (`state.js` `createSession`):

```js
{
  sid, hostId, channelId,
  mode: null,            // 'fifthgrader' once picked
  party: null,           // 'solo' | 'teams' once picked
  players: [hostId],     // MVP: just the host
  status: 'picking',     // 'picking' | 'lobby' | 'in_progress' | 'complete' | 'cancelled'
  questionIndex: 0,
  answers: [],           // { qIndex, value, correct, timedOut? }
  messageId: null,       // id of the current public message being edited
  timer: null,           // active setTimeout handle
  createdAt,
}
```

Step-by-step behaviour is the list in **§0 "What the MVP does"** — that *is* the current
flow. Code path: `handleInteraction` (entry) → `handleComponent` (per-`kind` switch) → the
game-loop helpers `startQuestions` → `showQuestion` (q0, edit) / `postQuestion` (q1+, send)
→ `advance` → `onQuestionTimeout`. A component whose `sid` has no live session returns an
ephemeral *"That trivia session expired — run `/start` again."*

### Later — multiplayer lobby (design, not built)

Turn the public message into a **join queue**: a **Join** button (`queue_join_<sid>` —
toggle, or a separate `queue_leave_<sid>`) that adds the clicker to `players` and edits the
message to show the roster, plus a host-only **Start Game**. Teams mode adds per-team join
buttons and team scoring. The current MVP replaces all of that with the solo 60s countdown
lobby.

---

## 7. Question file — MVP (JSON)

`questions/aystafg.json` (**A**re **Y**ou **S**marter **T**han **A** **F**ifth **G**rader),
read at startup by `trivia.js`:

```json
[
  { "id": 1, "prompt": "The sky is blue. Type Yes or No.", "answer": "yes" },
  { "id": 2, "prompt": "2 + 2 equals 5. Type Yes or No.", "answer": "no" }
]
```

`answer` is `"yes"` or `"no"`; the Yes/No buttons submit `"yes"`/`"no"` and `checkAnswer`
does a string compare. These two questions exist only to exercise correct/incorrect paths.

`trivia.js` API: `getQuestions()`, `getQuestion(index)`, `checkAnswer(question, value)`,
`QUESTION_COUNT`.

### Later — Markdown question bank (design, not built)

Move to `questions/<mode>.md`, parsed at runtime, supporting multiple choice + metadata:

```markdown
## Q: What is the capital of France?
- [x] Paris
- [ ] London
- [ ] Berlin
- grade: 3
- subject: Geography
```

Parser contract: each `## Q:` block = one question; `- [x]` / `- [ ]` = options (`[x]`
correct, allow 1+); `- key: value` = metadata; output
`[{ id, prompt, choices: [{ text, correct }], meta }]`. A free-text variant collapses to
one `- [x]` answer plus accepted-synonym lines.

---

## 8. Scoreboard (design, not built)

Persist to `data/scoreboard.json` (gitignored, created on first write), in-memory mirror in
`scoreboard.js`:

```jsonc
{
  "users": {
    "<discordUserId>": {
      "displayName": "<nickname>",
      "overall": { "wins": 0, "correctGuesses": 0, "gamesPlayed": 0 },
      "modes": { "fifthgrader": { "wins": 0, "correctGuesses": 0, "gamesPlayed": 0 } }
    }
  },
  "lastUpdated": "<ISO timestamp>"
}
```

Tracked metrics: **wins — overall** (all modes) and **per mode**; **correct guesses —
overall** and **per mode**. API sketch: `recordGameResult({ mode, players, winnerIds,
perPlayerCorrectCounts })`, `getScoreboard({ mode })`, `formatScoreboard(...)`.
Single-process synchronous JSON read/modify/write is fine; move to SQLite only if we run
multiple instances.

---

## 9. Deferred / out of scope

- **Teams mode** — `party` can already be `'teams'`, but choosing it is a no-op. Teams
  needs team creation, per-team join, team scoring.
- Other game modes (`trivia2` button exists, disabled).
- `/scoreboard`, `/stop`, `/settings`; host-only enforcement on lobby/answer buttons.
- Real questions; shuffling; configurable question count; scoring weights / tie-breaks.
- Persistence of any kind (sessions and scores are memory-only).
- Multiple concurrent sessions per channel.

---

## 10. Build phases

1. ~~Scaffold — `package.json`, `utils.js`, `.env.sample`, `.gitignore`, `README`.~~ ✅
2. ~~`commands.js` with `/start`; `npm run register`.~~ ✅
3. ~~`app.js` / `flow.js` — `/interactions` router, PING, command + component routing.~~ ✅
4. ~~Flow screens 1–4 — mode picker → confirm → solo/teams → public lobby + countdown.~~ ✅
5. ~~Question loop — 2 JSON questions, Yes/No, 10s timer, correct/incorrect, completion.~~ ✅
6. ~~Live test against Discord.~~ ✅ (2026-09-10)
7. Markdown question bank + parser; real questions.
8. Scoreboard + `/scoreboard` + persistence.
9. Teams mode + multiplayer lobby (§6 "Later").

Done between 6 and 7: ~~Migrate from HTTP interactions (Express + tunnel) to a discord.js
gateway bot, solo flow unchanged.~~ ✅ (2026-09-19; smoke test passes, bot logs in)

---

## 11. Resolved decisions

- **Answer input**: multiple-choice buttons (Yes/No for now), not a modal.
- **Questions per game / timer**: 2 questions, 10s each (both constants, easy to change).
- **Countdown**: 60s, shown via Discord's `<t:UNIX:R>` relative timestamp (no poll-editing).
- **Who can Start Now / Cancel / answer**: anyone, for the MVP (`// TODO: host-only?` marks
  the spots).
- **Sessions per channel**: assume one at a time.
- **Mode list wording**: `MODES` in `constants.js` — "Are You Smarter Than a Fifth Grader"
  (enabled) and a placeholder "Coming Soon" (disabled).

### Still open

- Real second game mode — name + questions.
- `/scoreboard` visibility (public vs ephemeral).
- Whether questions should shuffle and how many per game once real questions land.
