import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../csv.js';

const fieldsOf = (text) => parseCsv(text).map((r) => r.fields);

test('parses plain rows and records the start line of each', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [
    { line: 1, fields: ['a', 'b', 'c'] },
    { line: 2, fields: ['1', '2', '3'] },
  ]);
});

test('keeps empty fields, including trailing ones', () => {
  assert.deepEqual(fieldsOf('a,,c,\n,,\n'), [['a', '', 'c', ''], ['', '', '']]);
});

test('quoted fields may contain commas', () => {
  assert.deepEqual(fieldsOf('"a,b",c\n'), [['a,b', 'c']]);
});

test('doubled quotes inside a quoted field become one quote', () => {
  assert.deepEqual(fieldsOf('"say ""hi""",x\n'), [['say "hi"', 'x']]);
});

test('quoted fields may contain newlines, and later records keep the right line number', () => {
  const records = parseCsv('id,text\n1,"line one\nline two"\n2,after\n');
  assert.deepEqual(records, [
    { line: 1, fields: ['id', 'text'] },
    { line: 2, fields: ['1', 'line one\nline two'] },
    { line: 4, fields: ['2', 'after'] },
  ]);
});

test('CRLF inside quotes is preserved, CRLF between records is a record break', () => {
  assert.deepEqual(fieldsOf('a,"x\r\ny"\r\nb,c\r\n'), [['a', 'x\r\ny'], ['b', 'c']]);
});

test('LF, CRLF and a missing final newline all work', () => {
  assert.deepEqual(fieldsOf('a,b\nc,d'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(fieldsOf('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']]);
});

test('strips a UTF-8 BOM', () => {
  const [first] = parseCsv('﻿id,pack\n1,x\n');
  assert.deepEqual(first.fields, ['id', 'pack']);
});

test('skips blank lines but keeps a quoted empty field', () => {
  assert.deepEqual(fieldsOf('a\n\n\nb\n'), [['a'], ['b']]);
  assert.deepEqual(fieldsOf('""\n'), [['']]);
});

test('a quote in the middle of an unquoted field is literal', () => {
  assert.deepEqual(fieldsOf('5" pipe,x\n'), [['5" pipe', 'x']]);
});

test('keeps non-ASCII text intact', () => {
  assert.deepEqual(fieldsOf('Café,日本語,🙂\n'), [['Café', '日本語', '🙂']]);
});

test('an unterminated quote is an error that names the line it opened on', () => {
  assert.throws(() => parseCsv('a,b\nc,"never closed\nmore\n'), /line 2: quoted field is never closed/);
});

test('empty input has no records', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('\n\n'), []);
});
