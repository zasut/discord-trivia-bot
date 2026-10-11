import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle, ComponentType } from 'discord.js';
import { cid, parseCustomId } from '../constants.js';
import {
  NO_PINGS,
  answerModal,
  answerRow,
  clamp,
  correctAnswerText,
  displayName,
  mention,
  optionText,
  publicPayload,
  questionContent,
  resultContent,
  resultLine,
} from '../ui.js';

const SID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const choice = {
  type: 'choice',
  prompt: 'Which planet is red?',
  choices: ['Venus', 'Earth', 'Mars', 'Jupiter'],
  answer: 'C', // Mars
};
const typed = { type: 'typed', prompt: 'What is 6 x 7?', answer: '42', accepted: null };

// Shown as: A) Mars, B) Venus, C) Jupiter, D) Earth
const order = [2, 0, 3, 1];

describe('questionContent', () => {
  test('lists the choices in displayed order with fresh letters', () => {
    const text = questionContent({ label: '3rd · Science', number: 4, question: choice, order, deadlineMs: 1_700_000_000_500 });
    assert.equal(
      text,
      [
        '**3rd · Science** · Question 4',
        '',
        'Which planet is red?',
        '',
        '**A)** Mars',
        '**B)** Venus',
        '**C)** Jupiter',
        '**D)** Earth',
        '',
        '⏳ Closes <t:1700000001:R>',
      ].join('\n'),
    );
  });

  test('strikes out eliminated choices by displayed position', () => {
    const text = questionContent({ label: 'x', number: 1, question: choice, order, struck: [1, 3], deadlineMs: 0 });
    assert.match(text, /\*\*B\)\*\* ~~Venus~~/);
    assert.match(text, /\*\*D\)\*\* ~~Earth~~/);
    assert.match(text, /\*\*A\)\*\* Mars/);
  });

  test('typed questions have no choice list', () => {
    const text = questionContent({ label: 'x', number: 1, question: typed, order: null, deadlineMs: 5000 });
    assert.equal(text, ['**x** · Question 1', '', 'What is 6 x 7?', '', '⏳ Closes <t:5:R>'].join('\n'));
  });

  test('extra lines go at the end', () => {
    const text = questionContent({ label: 'x', number: 1, question: typed, order: null, deadlineMs: 0, extraLines: ['🟥 Red: ⏳'] });
    assert.ok(text.endsWith('\n🟥 Red: ⏳'));
  });

  test('the worst case fits in a Discord message', () => {
    const worst = {
      type: 'choice',
      prompt: 'p'.repeat(1000),
      choices: ['c'.repeat(200), 'd'.repeat(200), 'e'.repeat(200), 'f'.repeat(200)],
      answer: 'A',
    };
    const text = questionContent({ label: `5th · ${'s'.repeat(40)}`, number: 10, question: worst, order: [0, 1, 2, 3], struck: [1, 2], deadlineMs: 1_700_000_000_000 });
    assert.ok(text.length <= 2000, `${text.length} characters`);
  });
});

describe('answerRow', () => {
  test('choice questions get four buttons whose ids carry the position, not the letter', () => {
    const { type, components } = answerRow(SID, { seq: 3, question: choice, order });
    assert.equal(type, ComponentType.ActionRow);
    assert.deepEqual(components.map((c) => c.label), ['A', 'B', 'C', 'D']);
    assert.deepEqual(components.map((c) => c.custom_id), [0, 1, 2, 3].map((p) => cid.ans(SID, 3, p)));
    assert.ok(components.every((c) => c.style === ButtonStyle.Primary && !c.disabled));
  });

  test('ids are the same whatever the shuffle, so they cannot reveal the answer', () => {
    const ids = (o) => answerRow(SID, { seq: 3, question: choice, order: o }).components.map((c) => c.custom_id);
    assert.deepEqual(ids([0, 1, 2, 3]), ids([3, 2, 1, 0]));
    assert.deepEqual(ids([0, 1, 2, 3]), ids(order));
  });

  test('eliminated positions are disabled', () => {
    const { components } = answerRow(SID, { seq: 0, question: choice, order, struck: [0, 3] });
    assert.deepEqual(components.map((c) => c.disabled), [true, false, false, true]);
  });

  test('fewer choices means fewer buttons', () => {
    const two = { ...choice, choices: ['x', 'y'] };
    assert.equal(answerRow(SID, { seq: 0, question: two, order: [1, 0] }).components.length, 2);
  });

  test('typed questions get a single Answer button', () => {
    const { components } = answerRow(SID, { seq: 5, question: typed, order: null });
    assert.equal(components.length, 1);
    assert.equal(components[0].label, 'Answer');
    assert.deepEqual(parseCustomId(components[0].custom_id), { kind: 'typed', sid: SID, args: ['5'] });
  });
});

describe('answerModal', () => {
  test('is one required text input, within Discord limits', () => {
    const modal = answerModal(SID, 5);
    assert.deepEqual(parseCustomId(modal.custom_id), { kind: 'typedSubmit', sid: SID, args: ['5'] });
    assert.ok(modal.title.length <= 45);
    const [only] = modal.components;
    assert.equal(only.type, ComponentType.ActionRow);
    assert.equal(only.components.length, 1);
    const input = only.components[0];
    assert.equal(input.type, ComponentType.TextInput);
    assert.equal(input.custom_id, 'answer');
    assert.ok(input.label.length <= 45);
    assert.equal(input.required, true);
    assert.ok(input.max_length > 0 && input.max_length <= 4000);
  });
});

describe('results', () => {
  test('optionText uses the displayed letter', () => {
    assert.equal(optionText(choice, order, 2), 'A) Mars');
    assert.equal(optionText(choice, order, 1), 'D) Earth');
  });

  test('correctAnswerText', () => {
    assert.equal(correctAnswerText(choice, order), 'A) Mars');
    assert.equal(correctAnswerText(typed, null), '42');
    assert.equal(correctAnswerText({ type: 'typed', answer: 'a*b*c' }, null), 'a\\*b\\*c', 'markdown is escaped');
  });

  test('a correct choice answer', () => {
    assert.equal(resultLine({ question: choice, order, given: 'C', correct: true }), '✅ **Correct!** The answer was **A) Mars**.');
  });

  test('a wrong choice answer names both options as the player saw them', () => {
    assert.equal(
      resultLine({ question: choice, order, given: 'B', correct: false }),
      '❌ **Wrong.** You answered D) Earth. The answer was **A) Mars**.',
    );
  });

  test('a timeout', () => {
    assert.equal(resultLine({ question: choice, order, given: null, correct: false, timedOut: true }), "⏰ **Time's up!** The answer was **A) Mars**.");
    assert.equal(resultLine({ question: typed, order: null, given: null, correct: false, timedOut: true }), "⏰ **Time's up!** The answer was **42**.");
  });

  test('typed answers', () => {
    assert.equal(resultLine({ question: typed, order: null, given: '42.0', correct: true }), '✅ **Correct!** The answer was **42**.');
    assert.equal(resultLine({ question: typed, order: null, given: '41', correct: false }), '❌ **Wrong.** You answered "41". The answer was **42**.');
  });

  test("a player's typed text cannot inject markdown", () => {
    const line = resultLine({ question: typed, order: null, given: '**bold** ||spoiler|| @everyone', correct: false });
    assert.match(line, /You answered "\\\*\\\*bold\\\*\\\* \\\|\\\|spoiler\\\|\\\| @everyone"/);
  });

  test('resultContent joins header, prompt and result', () => {
    assert.equal(
      resultContent({ label: '3rd · Science', number: 2, question: typed, line: 'RESULT' }),
      '**3rd · Science** · Question 2\n\nWhat is 6 x 7?\n\nRESULT',
    );
  });
});

describe('payload helpers', () => {
  test('publicPayload never pings and defaults to no components', () => {
    assert.deepEqual(publicPayload('hi'), { content: 'hi', components: [], allowedMentions: { parse: [] } });
    assert.deepEqual(NO_PINGS, { parse: [] });
  });

  test('clamp keeps short text and truncates long text with an ellipsis', () => {
    assert.equal(clamp('short'), 'short');
    assert.equal(clamp('x'.repeat(2000)).length, 2000);
    const long = clamp('x'.repeat(3000));
    assert.equal(long.length, 2000);
    assert.ok(long.endsWith('…'));
    assert.equal(publicPayload('y'.repeat(5000)).content.length, 2000);
  });

  test('mention', () => {
    assert.equal(mention('123'), '<@123>');
  });

  test('displayName prefers the server nickname, then the global name, then the username', () => {
    assert.equal(displayName({ member: { displayName: 'Nick' }, user: { globalName: 'Glob', username: 'user' } }), 'Nick');
    assert.equal(displayName({ member: null, user: { globalName: 'Glob', username: 'user' } }), 'Glob');
    assert.equal(displayName({ user: { globalName: null, username: 'user' } }), 'user');
  });
});
