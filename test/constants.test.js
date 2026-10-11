import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DIFFICULTIES, PACKS, cid, parseCustomId } from '../constants.js';

const SID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('custom_id round trip', () => {
  const cases = [
    ['pack', ['fifthgrader']],
    ['packOk', []],
    ['packBack', []],
    ['fmtSolo', []],
    ['fmtNight', []],
    ['fmtBack', []],
    ['diff', ['standard']],
    ['diffBack', []],
    ['tile', ['7']],
    ['quit', []],
    ['ans', ['12', '3']],
    ['typed', ['12']],
    ['typedSubmit', ['12']],
    ['cheat', ['12', 'peek']],
    ['join', []],
    ['leave', []],
    ['makeTeams', []],
    ['cancelNight', []],
    ['teamCount', ['3']],
    ['shuffle', []],
    ['moveStart', []],
    ['movePlayer', []],
    ['moveTo', ['123456789012345678']],
    ['builderBack', []],
    ['startNight', []],
    ['assist', ['4']],
    ['assistPick', ['4']],
    ['next', []],
    ['anotherBoard', []],
    ['endNight', []],
  ];
  for (const [kind, args] of cases) {
    test(kind, () => {
      const id = cid[kind](SID, ...args);
      assert.equal(id, [kind, SID, ...args].join(':'));
      assert.deepEqual(parseCustomId(id), { kind, sid: SID, args });
    });
  }

  test('every builder has a test case', () => {
    assert.deepEqual(Object.keys(cid).sort(), cases.map(([kind]) => kind).sort());
  });

  test('numbers passed as args come back as strings', () => {
    assert.deepEqual(parseCustomId(cid.ans(SID, 4, 2)).args, ['4', '2']);
  });
});

describe('parseCustomId rejects what is not ours', () => {
  const bad = [
    ['not a string', 42],
    ['undefined', undefined],
    ['empty', ''],
    ['no sid', 'tile'],
    ['sid too short', 'tile:abc123'],
    ['sid with upper-case hex', `tile:${SID.toUpperCase()}`],
    ['sid with non-hex characters', `tile:${'z'.repeat(32)}`],
    ['sid too long', `tile:${SID}0`],
    ['unknown kind', `explode:${SID}`],
    ['an inherited property name', `toString:${SID}`],
    ['another inherited name', `constructor:${SID}`],
    ['the old underscore scheme', `answer_${SID}_0_yes`],
  ];
  for (const [name, input] of bad) {
    test(name, () => {
      const parsed = parseCustomId(input);
      assert.equal(parsed.kind, 'unknown');
      assert.equal(parsed.sid, null);
      assert.deepEqual(parsed.args, []);
      assert.equal(parsed.raw, input);
    });
  }
});

describe('building ids', () => {
  test('a ":" inside a part is refused, because it would corrupt the split', () => {
    assert.throws(() => cid.pack(SID, 'a:b'), /contains ":"/);
    assert.throws(() => cid.tile('bad:sid', 1), /contains ":"/);
  });

  test('ids over the 100-character Discord limit are refused', () => {
    assert.throws(() => cid.pack(SID, 'x'.repeat(70)), /longer than 100/);
    assert.doesNotThrow(() => cid.pack(SID, 'x'.repeat(50)));
  });

  test('the longest ids fit, even with a 20-digit user id', () => {
    assert.ok(cid.moveTo(SID, '9'.repeat(20)).length <= 100);
    assert.ok(cid.ans(SID, 999, 3).length <= 100);
    assert.ok(cid.cheat(SID, 999, 'peek').length <= 100);
  });

  test('answer buttons carry only numbers, never a choice letter', () => {
    for (let position = 0; position < 4; position++) {
      const { args } = parseCustomId(cid.ans(SID, 9, position));
      assert.ok(args.every((arg) => /^\d+$/.test(arg)), `position ${position}`);
    }
  });
});

describe('config', () => {
  test('pack keys are unique and contain no ":"', () => {
    const keys = PACKS.map((pack) => pack.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(keys.every((key) => !key.includes(':')));
  });

  test('every difficulty has its own key, a blurb, and lives / cheats', () => {
    for (const [key, difficulty] of Object.entries(DIFFICULTIES)) {
      assert.equal(difficulty.key, key);
      assert.ok(difficulty.blurb.length > 0);
      assert.ok(difficulty.lives >= 1);
      assert.ok(difficulty.cheats >= 0);
    }
    assert.equal(DIFFICULTIES.hard.lives, 1);
    assert.equal(DIFFICULTIES.hard.cheats, 0);
    assert.equal(DIFFICULTIES.standard.lives, 3);
    assert.equal(DIFFICULTIES.standard.cheats, 1);
    assert.equal(DIFFICULTIES.casual.lives, Infinity);
    assert.equal(DIFFICULTIES.casual.counted, false);
    assert.equal(DIFFICULTIES.hard.counted && DIFFICULTIES.standard.counted, true);
  });
});
