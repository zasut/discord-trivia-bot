// Answer checking. Pure functions, so they are easy to unit-test (DESIGN.md "Answer
// checking").

export const LETTERS = ['A', 'B', 'C', 'D'];

const ALNUM = /[\p{L}\p{N}]/u;

// Normalise typed text for comparison:
//   1. Unicode NFKC, lower-case, trim, collapse runs of whitespace to one space.
//   2. Strip leading and trailing characters that aren't letters or digits
//      ("Paris." -> "paris", "$5" -> "5"), but keep a minus sign or decimal point that
//      belongs to a number ("-5" stays "-5", ".5" stays ".5").
export function normalize(text) {
  const s = String(text).normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  const chars = Array.from(s); // by code point, so emoji aren't split
  const first = chars.findIndex((ch) => ALNUM.test(ch));
  if (first === -1) return '';
  let last = chars.length - 1;
  while (!ALNUM.test(chars[last])) last--;

  let core = chars.slice(first, last + 1).join('');
  if (/^\d/.test(core)) {
    let at = first;
    if (chars[at - 1] === '.') {
      core = `.${core}`;
      at--;
    }
    if (chars[at - 1] === '-' || chars[at - 1] === '−') core = `-${core}`;
  }
  return core;
}

// A normalised string as a number, or null. Thousands separators ("1,000") are allowed.
export function toNumber(normalized) {
  const s = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(normalized) ? normalized.replace(/,/g, '') : normalized;
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Does a typed guess match the canonical answer or any accepted alternative?
// Numbers are compared as numbers ("12" = "12.0"); everything else must match exactly
// after normalising. There is no fuzzy matching: add common variants to `accepted`.
export function checkTyped(question, guess) {
  const given = normalize(guess);
  if (given === '') return false;
  const givenNumber = toNumber(given);
  return [question.answer, ...(question.accepted ?? [])].some((candidate) => {
    const wanted = normalize(candidate);
    if (wanted === '') return false;
    const wantedNumber = toNumber(wanted);
    if (givenNumber !== null && wantedNumber !== null) return givenNumber === wantedNumber;
    return given === wanted;
  });
}

// `letter` is the ORIGINAL choice letter ('A'-'D'), not the position it was displayed at.
export function checkChoice(question, letter) {
  return question.answer === letter;
}
