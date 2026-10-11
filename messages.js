// Public channel messages, sent and edited by channel id through the discord.js client.
// Game timers have no interaction to reply with, so everything the bot posts on its own
// goes through here. Mentions never ping, whatever the payload says.

import { NO_PINGS } from './ui.js';

export async function sendMessage(client, channelId, payload) {
  const channel = await client.channels.fetch(channelId);
  return channel.send({ allowedMentions: NO_PINGS, ...payload });
}

export async function editMessage(client, channelId, messageId, payload) {
  const channel = await client.channels.fetch(channelId);
  return channel.messages.edit(messageId, { allowedMentions: NO_PINGS, ...payload });
}

// A bot can always delete its own messages.
export async function deleteMessage(client, channelId, messageId) {
  const channel = await client.channels.fetch(channelId);
  return channel.messages.delete(messageId);
}
