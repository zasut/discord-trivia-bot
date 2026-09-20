import 'dotenv/config';
import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { handleInteraction } from './flow.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is missing — add it to .env (see .env.sample).');
  process.exit(1);
}

// Gateway bot: we open a websocket to Discord and it pushes interactions down it, so
// there is no HTTP server, tunnel, or Interactions Endpoint URL. Slash commands and
// buttons need no privileged intents — `Guilds` is enough.
//
// The flow logic lives in flow.js:handleInteraction(interaction) so it can be
// smoke-tested without Discord (scripts/smoke.js).
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, (interaction) => {
  handleInteraction(interaction).catch((err) => {
    console.error('interaction handler error', err);
    // Best effort: tell the user instead of leaving them on "interaction failed".
    const notice = { content: 'Something went wrong — try `/start` again.', flags: MessageFlags.Ephemeral };
    const send = interaction.deferred || interaction.replied
      ? interaction.followUp(notice)
      : interaction.reply(notice);
    send.catch(() => {});
  });
});

client.on(Events.Error, (err) => console.error('discord client error', err));

client.login(process.env.DISCORD_TOKEN);
