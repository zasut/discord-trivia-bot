// Interaction flow logic for the walking-skeleton MVP (CONTEXT.md §0).
//
// app.js is a thin shell: it logs the discord.js client in and hands every
// `interactionCreate` event to `handleInteraction(interaction)`. Replies use the
// interaction itself (`reply` / `update` / `deferUpdate`); everything the bot posts
// on its own (lobby, later questions, completion) goes through the channel by id,
// so timer callbacks can post/edit without an interaction in hand.
//
// Ordering rule: session state is mutated (answer recorded, timer cleared) BEFORE the
// first `await`, so a double-click or a click racing a timeout can't double-advance.
//
// Message style: classic `{ content, components }` (string + action rows). The
// ephemeral picker / confirm / party screens are updated in place with
// `interaction.update`; the public lobby + question messages are plain channel messages.
//
// Per-question rendering choice: question 0 is produced by editing the public
// lobby message in place (`showQuestion`). Every subsequent question is posted as
// a FRESH channel message (`postQuestion`) per the CONTEXT.md §0 step-14
// recommendation ("a fresh message per question reads better"), updating
// session.messageId to the new id each time. Answer results and timeouts always
// edit whatever the current session.messageId is.

import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
} from 'discord.js';
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

const { Button: BUTTON, ActionRow: ACTION_ROW } = ComponentType;
const EPHEMERAL = MessageFlags.Ephemeral;

// How long a revealed answer/timeout stays on screen before the next question.
const RESULT_READ_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// setTimeout wrapper that stores the handle on the session and unref()s it so a
// pending game timer never holds the process open on its own (the gateway
// connection does that), which keeps shutdown clean.
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
      button(cid.modeSelect(m.key, sid), m.label, ButtonStyle.Secondary, {
        disabled: !m.enabled,
      }),
    ),
  );
}

function confirmComponents(sid) {
  return row(
    button(cid.modeConfirm(sid), 'Confirm', ButtonStyle.Primary),
    button(cid.modeBack(sid), 'Back', ButtonStyle.Secondary),
  );
}

function partyComponents(sid) {
  return row(
    button(cid.soloSelect(sid), 'Solo', ButtonStyle.Primary),
    button(cid.teamsSelect(sid), 'Teams', ButtonStyle.Secondary),
    button(cid.partyBack(sid), 'Back', ButtonStyle.Secondary),
  );
}

function lobbyComponents(sid) {
  return row(
    button(cid.lobbyStart(sid), 'Start Now', ButtonStyle.Success),
    button(cid.lobbyCancel(sid), 'Cancel', ButtonStyle.Danger),
  );
}

function answerComponents(sid, qIndex) {
  return row(
    button(cid.answer(sid, qIndex, 'yes'), 'Yes', ButtonStyle.Primary),
    button(cid.answer(sid, qIndex, 'no'), 'No', ButtonStyle.Secondary),
  );
}

function modeLabel(key) {
  const mode = MODES.find((m) => m.key === key);
  return mode ? mode.label : key;
}

// --- channel helpers -------------------------------------------------------

// Post / edit a public channel message by id, so timers can act with no interaction.
async function sendMessage(client, channelId, payload) {
  const channel = await client.channels.fetch(channelId);
  return channel.send(payload);
}

async function editMessage(client, channelId, messageId, payload) {
  const channel = await client.channels.fetch(channelId);
  return channel.messages.edit(messageId, payload);
}

// --- response helpers ------------------------------------------------------

// Edit the ephemeral message the button lives on (stays ephemeral).
const ephemeralUpdate = (interaction, content, components) =>
  interaction.update({ content, components });

// Bot was restarted (or session already ended) and getSession(sid) is undefined.
const staleResponse = (interaction) =>
  interaction.reply({
    flags: EPHEMERAL,
    content: 'That trivia session expired — run `/start` again.',
  });

// --- game-loop helpers (also driven by the timers) ------------------------

// CONTEXT.md §0 step 10 — also called by the lobby countdown timer.
export async function startQuestions(client, sid) {
  const session = getSession(sid);
  if (!session) return;
  updateSession(sid, { status: 'in_progress', questionIndex: 0 });
  await showQuestion(client, sid, 0);
}

// CONTEXT.md §0 step 11 — edit the current message into question `qIndex`.
// Used for question 0 (turns the lobby message into the first question).
export async function showQuestion(client, sid, qIndex) {
  const session = getSession(sid);
  if (!session) return;
  const q = getQuestion(qIndex);
  try {
    await editMessage(client, session.channelId, session.messageId, {
      content: `**Q${qIndex + 1}/${QUESTION_COUNT}**: ${q.prompt}`,
      components: answerComponents(sid, qIndex),
    });
  } catch (err) {
    console.error('showQuestion edit failed', err);
  }
  armTimer(
    sid,
    () => onQuestionTimeout(client, sid, qIndex).catch((e) => console.error(e)),
    QUESTION_TIMEOUT_MS,
  );
}

// Post a fresh channel message for question `qIndex` and re-point the session
// at it. Used for every question after the first (CONTEXT.md §0 step 14).
async function postQuestion(client, sid, qIndex) {
  const session = getSession(sid);
  if (!session) return;
  const q = getQuestion(qIndex);
  try {
    const msg = await sendMessage(client, session.channelId, {
      content: `**Q${qIndex + 1}/${QUESTION_COUNT}**: ${q.prompt}`,
      components: answerComponents(sid, qIndex),
    });
    updateSession(sid, { messageId: msg.id });
  } catch (err) {
    console.error('postQuestion send failed', err);
  }
  armTimer(
    sid,
    () => onQuestionTimeout(client, sid, qIndex).catch((e) => console.error(e)),
    QUESTION_TIMEOUT_MS,
  );
}

// CONTEXT.md §0 step 14 — move on, or finish and tear the session down.
export async function advance(client, sid, nextIndex) {
  const session = getSession(sid);
  if (!session) return;

  if (nextIndex < QUESTION_COUNT) {
    updateSession(sid, { questionIndex: nextIndex });
    await sleep(RESULT_READ_MS); // let the previous result stay readable
    await postQuestion(client, sid, nextIndex);
    return;
  }

  updateSession(sid, { status: 'complete' });
  const correctCount = session.answers.filter((a) => a.correct).length;
  try {
    await sendMessage(client, session.channelId, {
      content: `🏁 Trivia complete! You got **${correctCount}/${QUESTION_COUNT}** correct.`,
    });
  } catch (err) {
    console.error('completion send failed', err);
  }
  deleteSession(sid);
}

// CONTEXT.md §0 step 13 — fired by the per-question timer. Guarded so a late
// click that already recorded an answer can't be double-processed.
export async function onQuestionTimeout(client, sid, qIndex) {
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
    await editMessage(client, session.channelId, session.messageId, {
      content: `**Q${qIndex + 1}**: ${q.prompt}\n\n⏰ Time's up! The answer was **${q.answer}**.`,
      components: [],
    });
  } catch (err) {
    console.error('question timeout edit failed', err);
  }
  await advance(client, sid, qIndex + 1);
}

// --- component handlers -------------------------------------------------

async function handleComponent(interaction, parsed, session) {
  const { client } = interaction;
  const { kind, sid } = parsed;

  switch (kind) {
    case 'modeSelect': {
      const mode = MODES.find((m) => m.key === parsed.key);
      if (!mode || !mode.enabled) {
        // Buttons for disabled modes are rendered disabled, so this is just a
        // defensive path: stay on the picker.
        return ephemeralUpdate(
          interaction,
          "That mode isn't available yet.",
          modePickerComponents(sid),
        );
      }
      updateSession(sid, { mode: mode.key });
      return ephemeralUpdate(
        interaction,
        `You've selected: **${mode.label}**`,
        confirmComponents(sid),
      );
    }

    case 'modeConfirm':
      return ephemeralUpdate(interaction, 'Solo or teams?', partyComponents(sid));

    case 'modeBack':
      return ephemeralUpdate(
        interaction,
        'Which trivia game mode?',
        modePickerComponents(sid),
      );

    case 'teamsSelect':
      // Out of scope this sprint — the button works but does not advance.
      return ephemeralUpdate(
        interaction,
        'Solo or teams?\n\nTeams mode is coming soon — pick Solo for now.',
        partyComponents(sid),
      );

    case 'partyBack':
      return ephemeralUpdate(
        interaction,
        `You've selected: **${modeLabel(session.mode)}**`,
        confirmComponents(sid),
      );

    case 'soloSelect': {
      updateSession(sid, { party: 'solo', status: 'lobby' });
      await interaction.update({
        content: 'Lobby posted in the channel 👇',
        components: [],
      });
      const unix = Math.floor((Date.now() + LOBBY_COUNTDOWN_MS) / 1000);
      try {
        const msg = await sendMessage(client, session.channelId, {
          content: `**Are You Smarter Than a Fifth Grader** — starting <t:${unix}:R>`,
          components: lobbyComponents(sid),
        });
        updateSession(sid, { messageId: msg.id });
        armTimer(
          sid,
          () => startQuestions(client, sid).catch((e) => console.error(e)),
          LOBBY_COUNTDOWN_MS,
        );
      } catch (err) {
        console.error('soloSelect lobby send failed', err);
      }
      return;
    }

    case 'lobbyStart': {
      // TODO: host-only? Anyone may Start Now for the MVP.
      clearTimer(sid);
      await interaction.deferUpdate();
      await startQuestions(client, sid);
      return;
    }

    case 'lobbyCancel': {
      // TODO: host-only? Anyone may Cancel for the MVP.
      clearTimer(sid);
      deleteSession(sid);
      // The Cancel button lives on the public lobby message, so edit it in place.
      await interaction.update({ content: 'Trivia cancelled.', components: [] });
      return;
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
        await interaction.deferUpdate();
        return;
      }
      clearTimer(sid);
      const q = getQuestion(qIndex);
      const correct = checkAnswer(q, value);
      session.answers.push({ qIndex, value, correct });
      // The Yes/No buttons live on the current question message, so edit it in place.
      try {
        await interaction.update({
          content: `**Q${qIndex + 1}**: ${q.prompt}\n\nYou answered **${value}** — ${
            correct ? '✅ Correct!' : '❌ Incorrect.'
          }`,
          components: [],
        });
      } catch (err) {
        console.error('answer update failed', err);
      }
      await advance(client, sid, qIndex + 1);
      return;
    }

    default:
      console.error(`unknown component custom_id: ${interaction.customId}`);
  }
}

// --- entry point ---------------------------------------------------------

export async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'start') {
      const session = createSession({
        hostId: interaction.user.id,
        channelId: interaction.channelId,
      });
      await interaction.reply({
        flags: EPHEMERAL,
        content: 'Which trivia game mode?',
        components: modePickerComponents(session.sid),
      });
      return;
    }
    console.error(`unknown command: ${interaction.commandName}`);
    return;
  }

  if (interaction.isButton()) {
    const parsed = parseCustomId(interaction.customId);
    const session = parsed.sid ? getSession(parsed.sid) : undefined;
    if (parsed.kind !== 'unknown' && !session) {
      await staleResponse(interaction);
      return;
    }
    await handleComponent(interaction, parsed, session);
    return;
  }

  console.error('unhandled interaction type', interaction.type);
}
