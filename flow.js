// The single router for every interaction (app.js hands each one to handleInteraction),
// plus the ephemeral /start setup screens. Game logic lives in solo.js.
//
// Setup is a private (ephemeral) conversation: /start replies, then each button press
// edits that same message with `interaction.update`. Picking a difficulty hands over to
// solo.js, which posts the public game.

import { ButtonStyle, MessageFlags } from 'discord.js';
import { DIFFICULTIES, PACKS, SETUP_IDLE_MS, cid, parseCustomId } from './constants.js';
import { armTimer, createSession, deleteSession, getSession } from './state.js';
import { handleSolo, startSolo } from './solo.js';
import { formatStats, getPlayerStats } from './stats.js';
import { NO_PINGS, button, mention, row } from './ui.js';

const EPHEMERAL = MessageFlags.Ephemeral;

const SETUP_KINDS = new Set(['pack', 'packOk', 'packBack', 'fmtSolo', 'fmtNight', 'fmtBack', 'diff', 'diffBack']);

// --- setup screens ---------------------------------------------------------------------

const packPicker = (sid) => [
  row(
    ...PACKS.map((pack) =>
      button(cid.pack(sid, pack.key), pack.label, ButtonStyle.Secondary, { disabled: !pack.enabled }),
    ),
  ),
];

const confirmScreen = (sid) => [
  row(
    button(cid.packOk(sid), 'Confirm', ButtonStyle.Primary),
    button(cid.packBack(sid), 'Back', ButtonStyle.Secondary),
  ),
];

const formatScreen = (sid) => [
  row(
    button(cid.fmtSolo(sid), 'Solo', ButtonStyle.Primary),
    button(cid.fmtNight(sid), 'Trivia night (coming soon)', ButtonStyle.Secondary, { disabled: true }),
    button(cid.fmtBack(sid), 'Back', ButtonStyle.Secondary),
  ),
];

const difficultyScreen = (sid) => [
  row(
    ...Object.values(DIFFICULTIES).map((difficulty) =>
      button(cid.diff(sid, difficulty.key), difficulty.label, ButtonStyle.Primary),
    ),
    button(cid.diffBack(sid), 'Back', ButtonStyle.Secondary),
  ),
];

const PICK_PACK_TEXT = 'Which trivia game?';
const FORMAT_TEXT = 'Solo or trivia night?';
const DIFFICULTY_TEXT = [
  '**Pick a difficulty**',
  ...Object.values(DIFFICULTIES).map((difficulty) => `**${difficulty.label}**: ${difficulty.blurb}`),
].join('\n');

const packSelectedText = (key) => `You've selected: **${PACKS.find((pack) => pack.key === key)?.label ?? key}**`;

const showScreen = (interaction, content, components) => interaction.update({ content, components });

async function handleSetup(interaction, parsed, session) {
  const { sid } = session;
  if (session.status !== 'setup') {
    await interaction.deferUpdate();
    return;
  }
  // Any press keeps an unfinished setup alive for another SETUP_IDLE_MS.
  armTimer(sid, () => dropSetup(sid), SETUP_IDLE_MS);

  switch (parsed.kind) {
    case 'pack': {
      const pack = PACKS.find((p) => p.key === parsed.args[0]);
      if (!pack || !pack.enabled) {
        return showScreen(interaction, "That game isn't available yet.", packPicker(sid));
      }
      session.pack = pack.key;
      return showScreen(interaction, packSelectedText(pack.key), confirmScreen(sid));
    }
    case 'packOk':
      return showScreen(interaction, FORMAT_TEXT, formatScreen(sid));
    case 'packBack':
      return showScreen(interaction, PICK_PACK_TEXT, packPicker(sid));
    case 'fmtSolo':
      return showScreen(interaction, DIFFICULTY_TEXT, difficultyScreen(sid));
    case 'fmtNight':
      // The button is rendered disabled until trivia night exists.
      return showScreen(interaction, `${FORMAT_TEXT}\n\nTrivia night is coming soon. Pick Solo for now.`, formatScreen(sid));
    case 'fmtBack':
      return showScreen(interaction, packSelectedText(session.pack), confirmScreen(sid));
    case 'diffBack':
      return showScreen(interaction, FORMAT_TEXT, formatScreen(sid));
    case 'diff':
      return startSolo(interaction, session, parsed.args[0]);
    default:
      return interaction.deferUpdate();
  }
}

// Setup timer: an abandoned /start is forgotten. Its buttons then get the "expired" reply.
export function dropSetup(sid) {
  const session = getSession(sid);
  if (session && session.status === 'setup') deleteSession(sid);
}

// --- commands --------------------------------------------------------------------------

async function startCommand(interaction) {
  if (!interaction.guildId) {
    await interaction.reply({ flags: EPHEMERAL, content: 'Trivia runs in a server channel. Use `/start` there.' });
    return;
  }
  const session = createSession({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
  });
  armTimer(session.sid, () => dropSetup(session.sid), SETUP_IDLE_MS);
  await interaction.reply({
    flags: EPHEMERAL,
    content: PICK_PACK_TEXT,
    components: packPicker(session.sid),
  });
}

// /stats [user] [share]: private unless `share` is true.
async function statsCommand(interaction) {
  const target = interaction.options.getUser('user') ?? interaction.user;
  const share = interaction.options.getBoolean('share') ?? false;
  const stats = getPlayerStats(target.id);
  let content = formatStats(stats, target.id);
  if (!stats.hasData) {
    content =
      target.id === interaction.user.id ? 'No games yet. Run `/start`!' : `${mention(target.id)} hasn't played yet.`;
  }
  await interaction.reply({
    content,
    allowedMentions: NO_PINGS,
    ...(share ? {} : { flags: EPHEMERAL }),
  });
}

async function handleCommand(interaction) {
  if (interaction.commandName === 'start') return startCommand(interaction);
  if (interaction.commandName === 'stats') return statsCommand(interaction);
  console.error(`unknown command: ${interaction.commandName}`);
  return interaction.reply({ flags: EPHEMERAL, content: "I don't know that command." });
}

// --- components ------------------------------------------------------------------------

// The session behind this button is gone: the bot restarted, the game ended, or setup
// timed out.
function staleResponse(interaction) {
  return interaction.reply({
    flags: EPHEMERAL,
    content: interaction.isModalSubmit() ? '⏰ Too late.' : 'That trivia session expired — run `/start` again.',
  });
}

async function handleComponent(interaction) {
  const parsed = parseCustomId(interaction.customId);
  if (parsed.kind === 'unknown') {
    console.error(`unknown component custom_id: ${interaction.customId}`);
    return staleResponse(interaction);
  }
  const session = getSession(parsed.sid);
  if (!session) return staleResponse(interaction);

  if (SETUP_KINDS.has(parsed.kind)) return handleSetup(interaction, parsed, session);
  if (session.format === 'solo') return handleSolo(interaction, parsed, session);
  return staleResponse(interaction);
}

// --- entry point -----------------------------------------------------------------------

export async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) return handleCommand(interaction);
  if (interaction.isButton() || interaction.isModalSubmit()) return handleComponent(interaction);
  console.error('unhandled interaction type', interaction.type);
}
