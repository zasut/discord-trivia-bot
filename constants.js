// Packs, difficulties, tunables and the custom_id scheme (DESIGN.md "Tunables" and
// "custom_id scheme").

// --- Packs -------------------------------------------------------------------------
// Question packs shown in the ephemeral /start picker. `graded` packs organise their
// questions by grade 1-5 (the question CSV must give a grade); ungraded packs must leave
// it empty. Only `enabled` packs can be played.
export const PACKS = [
  { key: 'fifthgrader', label: 'Are You Smarter Than a Fifth Grader', enabled: true, graded: true },
  { key: 'trivia2', label: 'Coming Soon', enabled: false, graded: false },
];

export const GRADES = [1, 2, 3, 4, 5];
export const TILES_PER_GRADE = 2;

// --- Solo difficulties -----------------------------------------------------------------
export const STANDARD_LIVES = 3;

// lives / cheats: how many misses end the run, and how many cheats a run may use.
// `counted`: whether guesses made on this difficulty count toward stats.
export const DIFFICULTIES = {
  hard: {
    key: 'hard',
    label: 'Hard',
    lives: 1,
    cheats: 0,
    counted: true,
    blurb: 'One life and no cheats. Your first miss ends the run.',
  },
  standard: {
    key: 'standard',
    label: 'Standard',
    lives: STANDARD_LIVES,
    cheats: 1,
    counted: true,
    blurb: `${STANDARD_LIVES} lives and 1 cheat per run.`,
  },
  casual: {
    key: 'casual',
    label: 'Casual',
    lives: Infinity,
    cheats: Infinity,
    counted: false,
    blurb: 'Unlimited lives and cheats. Your guesses are saved but don\'t count toward stats.',
  },
};

// --- Tunables --------------------------------------------------------------------------
// Answer windows in ms, by game format and question type.
export const TIMERS = {
  solo: { choice: 20_000, typed: 45_000 },
  night: { choice: 30_000, typed: 60_000 },
};

export const PEEK_MIN_ANSWERS = 5; // prior counted guesses needed before Peek is offered
export const SETUP_IDLE_MS = 15 * 60_000; // drop an unfinished ephemeral setup
export const BOARD_IDLE_MS = 5 * 60_000; // solo board with no tile picked -> abandoned
export const SIGNUP_IDLE_MS = 30 * 60_000; // night sign-up never started -> cancelled
export const NIGHT_IDLE_MS = 30 * 60_000; // night with no activity -> abandoned
export const LEADERBOARD_MIN_ANSWERS = 20; // counted guesses needed to rank by accuracy

// Pauses that tests shrink to zero (smoke.js sets `timing.resultReadMs = 0`).
export const timing = {
  resultReadMs: 1500, // how long a result stays on screen before the next board
};

// --- custom_id scheme -------------------------------------------------------------------
// Every id is `<kind>:<sid>[:<arg>...]`. The router in flow.js recovers the session from
// `sid` and what was pressed from `kind`. Players can read ids in their Discord client, so
// an id must never carry anything that gives away an answer: answer buttons carry the
// displayed position (0-3), never the original choice letter.
//
// Kinds and args never contain ':'. `sid` is a crypto.randomUUID() with the dashes
// removed (32 hex characters, see state.js).

const SEP = ':';
const MAX_CUSTOM_ID = 100; // Discord's limit
const SID_PATTERN = /^[0-9a-f]{32}$/;

function makeId(kind, sid, ...args) {
  for (const part of [kind, sid, ...args]) {
    if (String(part).includes(SEP)) throw new Error(`custom_id part contains "${SEP}": ${part}`);
  }
  const id = [kind, sid, ...args].join(SEP);
  if (id.length > MAX_CUSTOM_ID) throw new Error(`custom_id longer than ${MAX_CUSTOM_ID} characters: ${id}`);
  return id;
}

const id = (kind) => (sid, ...args) => makeId(kind, sid, ...args);

// Builders, one per kind. A comment gives the args each one takes.
export const cid = {
  // setup (ephemeral)
  pack: id('pack'), //          (sid, packKey)
  packOk: id('packOk'),
  packBack: id('packBack'),
  fmtSolo: id('fmtSolo'),
  fmtNight: id('fmtNight'),
  fmtBack: id('fmtBack'),
  diff: id('diff'), //          (sid, 'hard' | 'standard' | 'casual')
  diffBack: id('diffBack'),
  // board + questions (public)
  tile: id('tile'), //          (sid, tileIndex)
  quit: id('quit'),
  ans: id('ans'), //            (sid, seq, displayedPosition)
  typed: id('typed'), //        (sid, seq): opens the answer modal
  typedSubmit: id('typedSubmit'), // (sid, seq): the modal's own id
};

// parseCustomId(componentId) -> { kind, sid, args }. Anything that isn't one of ours, or
// has a malformed sid, is { kind: 'unknown', sid: null, args: [], raw }.
export function parseCustomId(componentId) {
  const unknown = { kind: 'unknown', sid: null, args: [], raw: componentId };
  if (typeof componentId !== 'string') return unknown;
  const [kind, sid, ...args] = componentId.split(SEP);
  if (!Object.hasOwn(cid, kind) || !SID_PATTERN.test(sid ?? '')) return unknown;
  return { kind, sid, args };
}
