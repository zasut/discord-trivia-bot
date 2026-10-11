// The Fifth Grader board: building it from the question bank and rendering it as buttons
// (DESIGN.md "Fifth Grader board"). Shared by solo and trivia night.
//
// A board is an array of tiles `{ index, grade, subject, state }`, state being
// 'open' | 'right' | 'wrong' | 'skipped' (no question was left for it). Tiles are ordered
// by grade, then subject.

import { ButtonStyle, ComponentType } from 'discord.js';
import { GRADES, TILES_PER_GRADE, cid } from './constants.js';
import { subjectsAvailable } from './questions.js';
import { shuffle } from './rng.js';

export function ordinal(n) {
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n] ?? 'th';
  return `${n}${suffix}`;
}

// "3rd · Science"
export function tileLabel(tile) {
  return `${ordinal(tile.grade)} · ${tile.subject}`;
}

// For each grade pick up to two different subjects at random from those that still have
// an unused active question. Returns { ok: true, tiles } or, when a grade has nothing
// left, { ok: false, missingGrade } so the caller can tell the user to import more.
export function buildBoard(pack, { excludeIds = [] } = {}) {
  const tiles = [];
  for (const grade of GRADES) {
    const subjects = subjectsAvailable(pack, grade, excludeIds).map((s) => s.subject);
    if (subjects.length === 0) return { ok: false, missingGrade: grade };
    const chosen = shuffle(subjects).slice(0, TILES_PER_GRADE).sort((a, b) => a.localeCompare(b));
    for (const subject of chosen) tiles.push({ index: tiles.length, grade, subject, state: 'open' });
  }
  return { ok: true, tiles };
}

// Climb rule: only the lowest grade that still has an unplayed tile can be played.
export function currentGrade(tiles) {
  const open = tiles.filter((tile) => tile.state === 'open');
  return open.length === 0 ? null : Math.min(...open.map((tile) => tile.grade));
}

export function isClickable(tiles, tile) {
  return Boolean(tile) && tile.state === 'open' && tile.grade === currentGrade(tiles);
}

export function isCleared(tiles) {
  return tiles.every((tile) => tile.state !== 'open');
}

function tileButton(sid, tile, active) {
  const base = { type: ComponentType.Button, custom_id: cid.tile(sid, tile.index) };
  const label = tileLabel(tile);
  if (tile.state === 'right') return { ...base, label: `✅ ${label}`, style: ButtonStyle.Success, disabled: true };
  if (tile.state === 'wrong') return { ...base, label: `❌ ${label}`, style: ButtonStyle.Danger, disabled: true };
  if (tile.state === 'skipped') return { ...base, label: `➖ ${label}`, style: ButtonStyle.Secondary, disabled: true };
  const playable = tile.grade === active;
  return { ...base, label, style: playable ? ButtonStyle.Primary : ButtonStyle.Secondary, disabled: !playable };
}

// One action row per grade. Discord allows only 5 rows, so `control` (Quit / End night)
// goes at the end of the last grade's row.
export function boardComponents(sid, tiles, control) {
  const active = currentGrade(tiles);
  const rows = GRADES.map((grade) =>
    tiles.filter((tile) => tile.grade === grade).map((tile) => tileButton(sid, tile, active)),
  ).filter((buttons) => buttons.length > 0);
  if (control && rows.length > 0) rows[rows.length - 1].push(control);
  return rows.map((components) => ({ type: ComponentType.ActionRow, components }));
}
