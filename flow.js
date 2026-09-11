// Interaction flow logic for the walking-skeleton MVP (CONTEXT.md §0).
//
// The Express route in app.js is a thin shell: it runs verifyKeyMiddleware and
// then calls `handleInteraction(req.body)`. That function returns
//   { status?, body, after? }
// where `body` is the synchronous interaction response Discord needs within ~3s,
// `status` is an optional HTTP status (defaults to 200), and `after` is an
// optional async function the route invokes AFTER sending `body` — that's where
// all the follow-up REST work (DiscordRequest POST/PATCH) happens, so we never
// block the initial response on a network call.
//
// Message style: classic `{ content, components }` (string + action rows). The
// ephemeral picker / confirm / party screens keep the EPHEMERAL flag; the public
// lobby + question messages are plain channel messages posted with the bot token.
//
// Per-question rendering choice: question 0 is produced by PATCHing the public
// lobby message in place (`showQuestion`). Every subsequent question is posted as
// a FRESH channel message (`postQuestion`) per the CONTEXT.md §0 step-14
// recommendation ("a fresh message per question reads better"), updating
// session.messageId to the new id each time. Answer results and timeouts always
// PATCH whatever the current session.messageId is.

import {
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
  MessageComponentTypes,
  ButtonStyleTypes,
} from 'discord-interactions';
import { DiscordRequest } from './utils.js';
import {
  cid,
  parseCustomId,
  MODES,
  QUESTION_TIMEOUT_MS,
  LOBBY_COUNTDOWN_MS,
} from './constants.js';
import {
  createSession,
  getSession,
  updateSession,
  deleteSession,
  setTimer,
  clearTimer,
} from './state.js';
import { getQuestion, checkAnswer, QUESTION_COUNT } from './trivia.js';

const { BUTTON, ACTION_ROW } = MessageComponentTypes;
const EPHEMERAL = InteractionResponseFlags.EPHEMERAL;

// How long a revealed answer/timeout stays on screen before the next question.
const RESULT_READ_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// setTimeout wrapper that stores the handle on the session and unref()s it so a
// pending game timer never keeps the process alive on its own (Express does).
function armTimer(sid, fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === 'function') handle.unref();
  setTimer(sid, handle);
}

// --- payload builders --------------------------------------------------------

function button(custom_id, label, style, extra = {}) {
  return { type: BUTTON, custom_id, label, style, ...extra };
}

function row(...buttons) {
  return [{ type: ACTION_ROW, components: buttons }];
}

function modePickerComponents(sid) {
  return row(
    ...MODES.map((m) =>
      button(cid.modeSelect(m.key, sid), m.label, ButtonStyleTypes.SECONDARY, {
        disabled: !m.enabled,
      }),
    ),
  );
}

function confirmComponents(sid) {
  return row(
    button(cid.modeConfirm(sid), 'Confirm', ButtonStyleTypes.PRIMARY),
    button(cid.modeBack(sid), 'Back', ButtonStyleTypes.SECONDARY),
  );
}

function partyComponents(sid) {
  return row(
    button(cid.soloSelect(sid), 'Solo', ButtonStyleTypes.PRIMARY),
    button(cid.teamsSelect(sid), 'Teams', ButtonStyleTypes.SECONDARY),
    button(cid.partyBack(sid), 'Back', ButtonStyleTypes.SECONDARY),
  );
}

function lobbyComponents(sid) {
  return row(
    button(cid.lobbyStart(sid), 'Start Now', ButtonStyleTypes.SUCCESS),
    button(cid.lobbyCancel(sid), 'Cancel', ButtonStyleTypes.DANGER),
  );
}

function answerComponents(sid, qIndex) {
  return row(
    button(cid.answer(sid, qIndex, 'yes'), 'Yes', ButtonStyleTypes.PRIMARY),
    button(cid.answer(sid, qIndex, 'no'), 'No', ButtonStyleTypes.SECONDARY),
  );
}

function modeLabel(key) {
  const mode = MODES.find((m) => m.key === key);
  return mode ? mode.label : key;
}

// --- response helpers ------------------------------------------------------

function ephemeralUpdate(content, components) {
  return {
    body: {
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { flags: EPHEMERAL, content, components },
    },
  };
}

// Bot was restarted (or session already ended) and getSession(sid) is undefined.
function staleResponse() {
  return {
    body: {
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        flags: EPHEMERAL,
        content: 'That trivia session expired — run `/start` again.',
      },
    },
  };
}

const deferredUpdate = () => ({
  body: { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE },
});

// --- game-loop helpers (also driven by the timers) ------------------------

// CONTEXT.md §0 step 10 — also called by the lobby countdown timer.
export async function startQuestions(sid) {
  const session = getSession(sid);
  if (!session) return;
  updateSession(sid, { status: 'in_progress', questionIndex: 0 });
  await showQuestion(sid, 0);
}

// CONTEXT.md §0 step 11 — PATCH the current message into question `qIndex`.
// Used for question 0 (turns the lobby message into the first question).
export async function showQuestion(sid, qIndex) {
  const session = getSession(sid);
  if (!session) return;
  const q = getQuestion(qIndex);
  try {
    await DiscordRequest(
      `channels/${session.channelId}/messages/${session.messageId}`,
      {
        method: 'PATCH',
        body: {
          content: `**Q${qIndex + 1}/${QUESTION_COUNT}**: ${q.prompt}`,
          components: answerComponents(sid, qIndex),
        },
      },
    );
  } catch (err) {
    console.error('showQuestion PATCH failed', err);
  }
  armTimer(
    sid,
    () => onQuestionTimeout(sid, qIndex).catch((e) => console.error(e)),
    QUESTION_TIMEOUT_MS,
  );
}

// POST a fresh channel message for question `qIndex` and re-point the session
// at it. Used for every question after the first (CONTEXT.md §0 step 14).
async function postQuestion(sid, qIndex) {
  const session = getSession(sid);
  if (!session) return;
  const q = getQuestion(qIndex);
  try {
    const res = await DiscordRequest(
      `channels/${session.channelId}/messages`,
      {
        method: 'POST',
        body: {
          content: `**Q${qIndex + 1}/${QUESTION_COUNT}**: ${q.prompt}`,
          components: answerComponents(sid, qIndex),
        },
      },
    );
    const msg = await res.json();
    updateSession(sid, { messageId: msg.id });
  } catch (err) {
    console.error('postQuestion POST failed', err);
  }
  armTimer(
    sid,
    () => onQuestionTimeout(sid, qIndex).catch((e) => console.error(e)),
    QUESTION_TIMEOUT_MS,
  );
}

// CONTEXT.md §0 step 14 — move on, or finish and tear the session down.
export async function advance(sid, nextIndex) {
  const session = getSession(sid);
  if (!session) return;

  if (nextIndex < QUESTION_COUNT) {
    updateSession(sid, { questionIndex: nextIndex });
    await sleep(RESULT_READ_MS); // let the previous result stay readable
    await postQuestion(sid, nextIndex);
    return;
  }

  updateSession(sid, { status: 'complete' });
  const correctCount = session.answers.filter((a) => a.correct).length;
  try {
    await DiscordRequest(`channels/${session.channelId}/messages`, {
      method: 'POST',
      body: {
        content: `🏁 Trivia complete! You got **${correctCount}/${QUESTION_COUNT}** correct.`,
      },
    });
  } catch (err) {
    console.error('completion POST failed', err);
  }
  deleteSession(sid);
}

// CONTEXT.md §0 step 13 — fired by the per-question timer. Guarded so a late
// click that already recorded an answer can't be double-processed.
export async function onQuestionTimeout(sid, qIndex) {
  const session = getSession(sid);
  if (!session) return;
  if (
    session.status !== 'in_progress' ||
    qIndex !== session.questionIndex ||
    session.answers.some((a) => a.qIndex === qIndex)
  ) {
    return;
  }

  const q = getQuestion(qIndex);
  session.answers.push({ qIndex, value: null, correct: false, timedOut: true });
  try {
    await DiscordRequest(
      `channels/${session.channelId}/messages/${session.messageId}`,
      {
        method: 'PATCH',
        body: {
          content: `**Q${qIndex + 1}**: ${q.prompt}\n\n⏰ Time's up! The answer was **${q.answer}**.`,
          components: [],
        },
      },
    );
  } catch (err) {
    console.error('question timeout PATCH failed', err);
  }
  await advance(sid, qIndex + 1);
}

// --- component handlers -------------------------------------------------

function handleComponent(parsed, session, reqBody) {
  const { kind, sid } = parsed;
  const { data } = reqBody;

  switch (kind) {
    case 'modeSelect': {
      const mode = MODES.find((m) => m.key === parsed.key);
      if (!mode || !mode.enabled) {
        // Buttons for disabled modes are rendered disabled, so this is just a
        // defensive path: stay on the picker.
        return ephemeralUpdate(
          "That mode isn't available yet.",
          modePickerComponents(sid),
        );
      }
      updateSession(sid, { mode: mode.key });
      return ephemeralUpdate(
        `You've selected: **${mode.label}**`,
        confirmComponents(sid),
      );
    }

    case 'modeConfirm':
      return ephemeralUpdate('Solo or teams?', partyComponents(sid));

    case 'modeBack':
      return ephemeralUpdate(
        'Which trivia game mode?',
        modePickerComponents(sid),
      );

    case 'teamsSelect':
      // Out of scope this sprint — the button works but does not advance.
      return ephemeralUpdate(
        'Solo or teams?\n\nTeams mode is coming soon — pick Solo for now.',
        partyComponents(sid),
      );

    case 'partyBack':
      return ephemeralUpdate(
        `You've selected: **${modeLabel(session.mode)}**`,
        confirmComponents(sid),
      );

    case 'soloSelect': {
      updateSession(sid, { party: 'solo', status: 'lobby' });
      const channelId = session.channelId;
      const token = reqBody.token;
      const after = async () => {
        const unix = Math.floor((Date.now() + LOBBY_COUNTDOWN_MS) / 1000);
        try {
          const res = await DiscordRequest(`channels/${channelId}/messages`, {
            method: 'POST',
            body: {
              content: `**Are You Smarter Than a Fifth Grader** — starting <t:${unix}:R>`,
              components: lobbyComponents(sid),
            },
          });
          const msg = await res.json();
          updateSession(sid, { messageId: msg.id, token });
          armTimer(
            sid,
            () => startQuestions(sid).catch((e) => console.error(e)),
            LOBBY_COUNTDOWN_MS,
          );
        } catch (err) {
          console.error('soloSelect lobby POST failed', err);
        }
      };
      return {
        body: {
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { flags: EPHEMERAL, content: 'Lobby posted in the channel 👇', components: [] },
        },
        after,
      };
    }

    case 'lobbyStart': {
      // TODO: host-only? Anyone may Start Now for the MVP.
      clearTimer(sid);
      return {
        ...deferredUpdate(),
        after: async () => {
          await startQuestions(sid);
        },
      };
    }

    case 'lobbyCancel': {
      // TODO: host-only? Anyone may Cancel for the MVP.
      clearTimer(sid);
      const { channelId, messageId } = session;
      deleteSession(sid);
      return {
        ...deferredUpdate(),
        after: async () => {
          try {
            await DiscordRequest(
              `channels/${channelId}/messages/${messageId}`,
              {
                method: 'PATCH',
                body: { content: 'Trivia cancelled.', components: [] },
              },
            );
          } catch (err) {
            console.error('lobbyCancel PATCH failed', err);
          }
        },
      };
    }

    case 'answer': {
      // TODO: host-only? Anyone may answer for the MVP.
      const { qIndex, value } = parsed;
      if (
        session.status !== 'in_progress' ||
        qIndex !== session.questionIndex ||
        session.answers.some((a) => a.qIndex === qIndex)
      ) {
        // Stale / duplicate click — silently acknowledge, change nothing.
        return deferredUpdate();
      }
      clearTimer(sid);
      const q = getQuestion(qIndex);
      const correct = checkAnswer(q, value);
      session.answers.push({ qIndex, value, correct });
      return {
        ...deferredUpdate(),
        after: async () => {
          try {
            await DiscordRequest(
              `channels/${session.channelId}/messages/${session.messageId}`,
              {
                method: 'PATCH',
                body: {
                  content: `**Q${qIndex + 1}**: ${q.prompt}\n\nYou answered **${value}** — ${
                    correct ? '✅ Correct!' : '❌ Incorrect.'
                  }`,
                  components: [],
                },
              },
            );
          } catch (err) {
            console.error('answer PATCH failed', err);
          }
          await advance(sid, qIndex + 1);
        },
      };
    }

    default:
      console.error(`unknown component custom_id: ${data.custom_id}`);
      return { status: 400, body: { error: 'unknown component' } };
  }
}

// --- entry point ---------------------------------------------------------

export async function handleInteraction(reqBody) {
  const { type, data } = reqBody;
  const context = reqBody.context;
  const userId =
    context === 0 ? reqBody.member?.user?.id : reqBody.user?.id;

  if (type === InteractionType.PING) {
    return { body: { type: InteractionResponseType.PONG } };
  }

  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name } = data;
    if (name === 'start') {
      const session = createSession({
        hostId: userId,
        channelId: reqBody.channel_id || reqBody.channel?.id,
      });
      return {
        body: {
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: EPHEMERAL,
            content: 'Which trivia game mode?',
            components: modePickerComponents(session.sid),
          },
        },
      };
    }
    console.error(`unknown command: ${name}`);
    return { status: 400, body: { error: 'unknown command' } };
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const parsed = parseCustomId(data.custom_id);
    const session = parsed.sid ? getSession(parsed.sid) : undefined;
    if (parsed.kind !== 'unknown' && !session) {
      return staleResponse();
    }
    return handleComponent(parsed, session, reqBody);
  }

  console.error('unknown interaction type', type);
  return { status: 400, body: { error: 'unknown interaction type' } };
}
