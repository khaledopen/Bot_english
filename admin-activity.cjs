const fs = require('node:fs');
const path = require('node:path');

function createFileActivity(env) {
  const file = path.resolve(env.ADMIN_ACTIVITY_FILE || 'data/admin-activity.jsonl');
  const users = new Set();
  const announced = new Set();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
        const entry = JSON.parse(line);
        if (entry.event === 'seen') users.add(entry.id);
        if (entry.event === 'posted') announced.add(entry.id);
      }
    }
  } catch {
    console.warn('Suivi admin désactivé : le registre est inaccessible ou illisible.');
    return;
  }

  function record(event, id) {
    fs.appendFileSync(file, JSON.stringify({ event, id }) + '\n', { mode: 0o600 });
  }

  return {
    needsAnnouncement(id) {
      if (!users.has(id)) {
        record('seen', id);
        users.add(id);
      }
      return !announced.has(id);
    },
    markAnnounced(id) {
      announced.add(id);
      record('posted', id);
    },
    count: () => users.size,
  };
}

function installAdminActivity(bot, env = process.env) {
  const owner = (env.ADMIN_USER_ID || '').trim();
  const channel = (env.ADMIN_CHANNEL_ID || '').trim();
  const notify = /^\d+$/.test(owner) && /^-100\d+$/.test(channel);
  if ((owner || channel) && !notify) console.warn('Notifications admin désactivées : vérifie ADMIN_USER_ID et ADMIN_CHANNEL_ID.');

  const databaseUrl = env.ADMIN_DATABASE_URL?.trim();
  if (!databaseUrl && env.RENDER === 'true') {
    console.warn('Suivi admin désactivé : configure ADMIN_DATABASE_URL sur Render.');
    return;
  }
  if (!databaseUrl && !notify) return;
  const store = databaseUrl
    ? require('./admin-postgres.cjs').createPostgresActivity(databaseUrl)
    : createFileActivity(env);
  if (!store) return;
  const sending = new Set();

  async function announce(ctx, id) {
    try {
      if (!await store.needsAnnouncement(id)) return;
      const destination = await ctx.telegram.getChat(channel);
      if (destination.type !== 'channel' || destination.username || destination.active_usernames?.length) {
        console.warn('Notification admin annulée : le canal doit être privé.');
        return;
      }
      const name = [ctx.from.first_name, ctx.from.last_name]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 140);
      const account = ctx.from.username ? `@${ctx.from.username} · ` : '';
      const total = await store.count();
      await ctx.telegram.sendMessage(
        channel,
        `Nouvel utilisateur suivi\n${name || 'Compte Telegram'}\n${account}ID Telegram : ${id}\nTotal suivi : ${total}`,
        { protect_content: true },
      );
      await store.markAnnounced(id);
    } catch {
      console.warn('Notification admin non enregistrée : vérifie le canal et le stockage.');
    } finally {
      sending.delete(id);
    }
  }

  bot.command('admin_stats', async (ctx) => {
    if (!notify || ctx.chat?.type !== 'private' || String(ctx.from?.id) !== owner) return;
    let total;
    try {
      total = await store.count();
    } catch {
      return ctx.reply('Le compteur est temporairement indisponible.');
    }
    return ctx.reply(`Utilisateurs uniques suivis : ${total}`);
  });

  bot.use((ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot ||
        (!ctx.message && !ctx.callbackQuery)) return next();

    const id = String(ctx.from.id);
    const message = ctx.message;
    const isVoice = Boolean(message?.voice || message?.audio);
    const isText = typeof message?.text === 'string' && !message.text.startsWith('/');
    const level = ctx.callbackQuery?.data?.match(/^lvl_(beginner|intermediate|advanced)$/)?.[1] || null;
    if (store.track) {
      store.track(ctx.from, { messages: isText || isVoice ? 1 : 0, voice: isVoice ? 1 : 0, level })
        .catch(() => console.warn('Suivi Telegram non enregistré.'));
    }
    if (notify && !sending.has(id)) {
      sending.add(id);
      void announce(ctx, id);
    }
    return next();
  });
  const probe = async () => {
    try {
      await store.count();
      return { status: 'ok' };
    } catch (error) {
      return { status: 'unavailable', reason: databaseUrl
        ? require('./admin-postgres.cjs').describeFailure(error)
        : 'LOCAL_STORE_ERROR' };
    }
  };
  probe.getLevel = id => (store.getLevel ? store.getLevel(id) : null);
  return probe;
}

module.exports = { installAdminActivity };
