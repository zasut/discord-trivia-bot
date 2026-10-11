// Solo cheats (DESIGN.md "Cheats"): which are available, which wrong answers 50/50
// strikes out, and the text Peek shows. Pure apart from the rng, so it is easy to test.
// solo.js applies them and records the uses.

import { escapeMarkdown } from 'discord.js';
import { LETTERS, normalize } from './answers.js';
import { PEEK_MIN_ANSWERS } from './constants.js';
import { shuffle } from './rng.js';

// The order the buttons appear in. `kind` is what goes in the custom_id; `db` is the value
// stored in cheat_uses.cheat.
export const CHEATS = [
  { kind: 'peek', db: 'peek', label: '👀 Peek' },
  { kind: 'fifty', db: 'fifty', label: '✂️ 50/50' },
  { kind: 'swap', db: 'swap', label: '🔄 Swap' },
  { kind: 'time', db: 'extra_time', label: '⏱️ Extra time' },
];

export const CHEAT_KINDS = CHEATS.map((cheat) => cheat.kind);

// Which cheats can be used on the question on screen. Each can be used at most once per
// question. `peekTotal` is how many counted answers other games gave this question, and
// `swapAvailable` whether another unused question exists for the tile.
export function cheatAvailability({ question, struck = [], used, peekTotal, swapAvailable }) {
  return {
    peek: !used.has('peek') && peekTotal >= PEEK_MIN_ANSWERS,
    fifty:
      !used.has('fifty') &&
      question.type === 'choice' &&
      question.choices.length >= 3 &&
      question.choices.length - struck.length > 2,
    swap: !used.has('swap') && Boolean(swapAvailable),
    time: !used.has('time'),
  };
}

// The positions 50/50 strikes out: random wrong answers until two choices remain. Never
// the correct one. `order[position]` is the index into question.choices shown there.
export function pickStruck(question, order) {
  const correct = LETTERS.indexOf(question.answer);
  const wrong = order.map((original, position) => (original === correct ? -1 : position)).filter((p) => p >= 0);
  return shuffle(wrong)
    .slice(0, Math.max(0, question.choices.length - 2))
    .sort((a, b) => a - b);
}

// How other players answered, from their stored answers (the original letter for choice
// questions, the typed text for typed ones). Choice results use the letters as they are
// displayed to this player right now.
export function peekText({ question, order, answers }) {
  const total = answers.length;
  const percent = (n) => `${Math.round((100 * n) / total)}%`;
  const counts = new Map();
  let parts;

  if (question.type === 'choice') {
    for (const answer of answers) counts.set(answer, (counts.get(answer) ?? 0) + 1);
    parts = order.map((original, position) => `${LETTERS[position]} ${percent(counts.get(LETTERS[original]) ?? 0)}`);
  } else {
    for (const answer of answers) {
      const key = normalize(answer) || '(blank)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    parts = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([text, n]) => `"${escapeMarkdown(text)}" ${percent(n)}`);
  }
  return `👀 **Peek**\n${parts.join(' · ')} (${total} answers)`;
}
