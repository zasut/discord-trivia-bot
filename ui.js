// Payload builders: buttons, rows, modals and the text of question / result messages.
// Pure functions that return plain objects for discord.js, so they can be tested without
// Discord. Message style is classic `{ content, components }`; Components V2 is
// deliberately not used.

import { ButtonStyle, ComponentType, TextInputStyle, escapeMarkdown } from 'discord.js';
import { LETTERS } from './answers.js';
import { CHEATS } from './cheats.js';
import { cid } from './constants.js';

// Mentions still render as names but never notify anyone.
export const NO_PINGS = { parse: [] };

const MAX_CONTENT = 2000;

export function clamp(text, max = MAX_CONTENT) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const mention = (userId) => `<@${userId}>`;

// The name to store for whoever caused an interaction: their server nickname, else their
// global display name, else their username.
export function displayName(interaction) {
  return interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
}

export function button(customId, label, style, extra = {}) {
  return { type: ComponentType.Button, custom_id: customId, label, style, ...extra };
}

// One action row holding the given components.
export function row(...components) {
  return { type: ComponentType.ActionRow, components };
}

// A row holding one select menu. `options` is [{ label, value, description? }].
export function selectRow(customId, placeholder, options) {
  return row({
    type: ComponentType.StringSelect,
    custom_id: customId,
    placeholder,
    min_values: 1,
    max_values: 1,
    options,
  });
}

// A payload for a public (non-ephemeral) message: clamped, and never pings anyone.
export function publicPayload(content, components = []) {
  return { content: clamp(content), components, allowedMentions: NO_PINGS };
}

// --- questions ---------------------------------------------------------------------------

// `order[position]` is the index into question.choices shown at that position, because the
// choices are shuffled every time a question is shown.
export function questionContent({ label, number, question, order, struck = [], deadlineMs, extraLines = [] }) {
  const lines = [`**${label}** · Question ${number}`, '', question.prompt];
  if (question.type === 'choice') {
    lines.push('');
    order.forEach((original, position) => {
      const text = question.choices[original];
      lines.push(`**${LETTERS[position]})** ${struck.includes(position) ? `~~${text}~~` : text}`);
    });
  }
  lines.push('', `⏳ Closes <t:${Math.ceil(deadlineMs / 1000)}:R>`);
  if (extraLines.length > 0) lines.push(...extraLines);
  return lines.join('\n');
}

// Row of answer buttons. The ids carry the displayed position, never the choice letter.
export function answerRow(sid, { seq, question, order, struck = [] }) {
  if (question.type === 'typed') return row(button(cid.typed(sid, seq), 'Answer', ButtonStyle.Primary));
  return row(
    ...order.map((_, position) =>
      button(cid.ans(sid, seq, position), LETTERS[position], ButtonStyle.Primary, {
        disabled: struck.includes(position),
      }),
    ),
  );
}

// The row of cheat buttons. `available[kind]` says which can be used right now; the rest
// are drawn disabled.
export function cheatRow(sid, seq, available) {
  return row(
    ...CHEATS.map(({ kind, label }) =>
      button(cid.cheat(sid, seq, kind), label, ButtonStyle.Secondary, { disabled: !available[kind] }),
    ),
  );
}

// The pop-up text box for typed questions.
export function answerModal(sid, seq) {
  return {
    title: 'Your answer',
    custom_id: cid.typedSubmit(sid, seq),
    components: [
      row({
        type: ComponentType.TextInput,
        custom_id: 'answer',
        label: 'Type your answer',
        style: TextInputStyle.Short,
        required: true,
        max_length: 100,
      }),
    ],
  };
}

// "C) Mars", using the letter the option was displayed with.
export function optionText(question, order, originalIndex) {
  return `${LETTERS[order.indexOf(originalIndex)]}) ${question.choices[originalIndex]}`;
}

// The correct answer as the player saw it.
export function correctAnswerText(question, order) {
  if (question.type === 'typed') return escapeMarkdown(question.answer);
  return optionText(question, order, LETTERS.indexOf(question.answer));
}

// One line saying how a question went. `given` is the ORIGINAL choice letter for choice
// questions, or the typed text.
export function resultLine({ question, order, given, correct, timedOut }) {
  const answer = correctAnswerText(question, order);
  if (timedOut) return `⏰ **Time's up!** The answer was **${answer}**.`;
  if (correct) return `✅ **Correct!** The answer was **${answer}**.`;
  const youSaid =
    question.type === 'typed'
      ? `"${escapeMarkdown(given)}"`
      : optionText(question, order, LETTERS.indexOf(given));
  return `❌ **Wrong.** You answered ${youSaid}. The answer was **${answer}**.`;
}

export function resultContent({ label, number, question, line }) {
  return [`**${label}** · Question ${number}`, '', question.prompt, '', line].join('\n');
}
