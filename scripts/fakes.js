// A fake Discord for offline tests (used by scripts/smoke.js and the unit tests).
//
//  - `client` records every message the bot sends, edits or deletes by channel id, and
//    keeps the live messages so tests can read the buttons the bot actually rendered.
//  - interaction builders (command / button / modal) record which reply method the bot
//    used. Like Discord, they throw if an interaction is acknowledged twice, or answered
//    with followUp before being acknowledged, so a double-ack bug fails a test.

// Small deterministic PRNG (mulberry32) for rng.setRng().
export function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const makeUser = (id, name = `User ${id}`) => ({
  id,
  username: name.toLowerCase().replace(/\s+/g, ''),
  globalName: name,
  displayName: name,
});

// Every button / select inside a message's action rows, flattened.
export function componentsOf(message) {
  return (message?.components ?? []).flatMap((rowObject) => rowObject.components ?? []);
}

export function createFakeDiscord() {
  let nextId = 1;
  const messages = new Map(); // id -> { id, channelId, content, components, deleted }
  const traffic = []; // { op: 'send' | 'edit' | 'delete', channelId, messageId, payload }
  const failures = { send: false }; // set failures.send = true to make posting fail

  const client = {
    channels: {
      fetch: async (channelId) => ({
        id: channelId,
        send: async (payload) => {
          if (failures.send) throw new Error('Missing Access');
          const id = `m${nextId++}`;
          messages.set(id, {
            id,
            channelId,
            content: payload.content,
            components: payload.components ?? [],
            allowedMentions: payload.allowedMentions,
            deleted: false,
          });
          traffic.push({ op: 'send', channelId, messageId: id, payload });
          return { id };
        },
        messages: {
          edit: async (id, payload) => {
            const message = messages.get(id);
            if (!message || message.deleted) throw new Error('Unknown Message');
            if ('content' in payload) message.content = payload.content;
            if ('components' in payload) message.components = payload.components;
            traffic.push({ op: 'edit', channelId, messageId: id, payload });
            return { id };
          },
          delete: async (id) => {
            const message = messages.get(id);
            if (!message || message.deleted) throw new Error('Unknown Message');
            message.deleted = true;
            traffic.push({ op: 'delete', channelId, messageId: id });
          },
        },
      }),
    },
  };

  // Messages that haven't been deleted, oldest first.
  const live = (channelId) => [...messages.values()].filter((m) => m.channelId === channelId && !m.deleted);
  const latest = (channelId) => live(channelId).at(-1);
  // The live message holding a component with this custom_id, if any.
  const holding = (customId) =>
    [...messages.values()].find((m) => !m.deleted && componentsOf(m).some((c) => c.custom_id === customId));

  function build(type, { user, channelId, guildId, customId, commandName, options, fields, values, messageId, failOn }) {
    const calls = [];
    let acknowledged = null;
    const acknowledge = (method) => {
      if (failOn === method) throw new Error(`Unknown interaction (${method} failed on purpose)`);
      if (acknowledged) throw new Error(`InteractionAlreadyReplied: ${method} after ${acknowledged}`);
      acknowledged = method;
    };
    const needAcknowledged = (method) => {
      if (!acknowledged) throw new Error(`${method} before the interaction was acknowledged`);
    };
    const record = (method, payload) => calls.push({ method, payload });
    // The message the component lives on. A modal submit names it with `messageId`.
    const source = messageId ? messages.get(messageId) : customId ? holding(customId) : undefined;

    return {
      client,
      user,
      member: { displayName: user.displayName },
      guildId,
      channelId,
      customId,
      commandName,
      options,
      fields,
      values,
      message: source ? { id: source.id } : undefined,
      calls,
      isChatInputCommand: () => type === 'command',
      isButton: () => type === 'button',
      isModalSubmit: () => type === 'modal',
      isStringSelectMenu: () => type === 'select',
      get deferred() {
        return acknowledged === 'deferUpdate';
      },
      get replied() {
        return acknowledged === 'reply' || acknowledged === 'update';
      },
      reply: async (payload) => {
        acknowledge('reply');
        record('reply', payload);
      },
      update: async (payload) => {
        acknowledge('update');
        record('update', payload);
        if (source && !source.deleted) {
          if ('content' in payload) source.content = payload.content;
          if ('components' in payload) source.components = payload.components;
        }
      },
      deferUpdate: async () => {
        acknowledge('deferUpdate');
        record('deferUpdate');
      },
      showModal: async (modal) => {
        acknowledge('showModal');
        record('showModal', modal);
      },
      followUp: async (payload) => {
        needAcknowledged('followUp');
        record('followUp', payload);
      },
      editReply: async (payload) => {
        needAcknowledged('editReply');
        record('editReply', payload);
      },
    };
  }

  return {
    client,
    messages,
    traffic,
    failures,
    live,
    latest,
    holding,
    command: (commandName, user, { channelId, guildId = 'guild1', options = {} } = {}) =>
      build('command', { user, channelId, guildId, commandName, options }),
    button: (customId, user, { channelId, guildId = 'guild1', failOn } = {}) =>
      build('button', { user, channelId, guildId, customId, failOn }),
    select: (customId, user, values, { channelId, guildId = 'guild1' } = {}) =>
      build('select', { user, channelId, guildId, customId, values }),
    modal: (customId, user, { text = '', channelId, guildId = 'guild1', messageId, failOn } = {}) =>
      build('modal', {
        user,
        channelId,
        guildId,
        customId,
        messageId,
        failOn,
        fields: { getTextInputValue: () => text },
      }),
  };
}
