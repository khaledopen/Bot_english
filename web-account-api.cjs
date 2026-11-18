const { randomUUID } = require('node:crypto');
const { createAuth, isAdmin, normalizeUsername, publicAccount, WebError } = require('./web-account-auth.cjs');
const { describeFailure } = require('./admin-postgres.cjs');

const LIMIT_AUDIO = 3 * 1024 * 1024;
const AUDIO = { 'audio/webm': ['webm', '1a45dfa3'], 'audio/ogg': ['ogg', '4f676753'], 'audio/mp4': ['m4a', 'ftyp'] };
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const MODES = ['text', 'voice', 'both'];
const GOALS = ['speaking', 'everyday', 'professional', 'interviews', 'grammar'];
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validId = value => typeof value === 'string' && UUID.test(value);
const bad = message => new WebError(400, message);
const missing = () => new WebError(404, 'Élément introuvable.');

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function parseBody(req, limit) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
    throw new WebError(415, 'Utilise le format JSON.');
  }
  if (Number(req.headers['content-length']) > limit) throw new WebError(413, 'Ce message est trop volumineux.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    if ((size += chunk.length) > limit) throw new WebError(413, 'Ce message est trop volumineux.');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw bad('Cette demande ne peut pas être lue.');
}

function preferences(body) {
  const { level, goal, mode, dailyMinutes } = body;
  if (!LEVELS.includes(level) || !GOALS.includes(goal) || !MODES.includes(mode) ||
      ![10, 20, 30].includes(dailyMinutes)) throw bad('Vérifie tes préférences.');
  return { level, goal, mode, dailyMinutes };
}

function decodeAudio(body) {
  const type = typeof body.mimeType === 'string' ? body.mimeType.split(';')[0].toLowerCase() : '';
  const format = Object.hasOwn(AUDIO, type) && AUDIO[type];
  if (!format || typeof body.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) {
    throw bad('Envoie un vocal dans un format pris en charge.');
  }
  const [extension, signature] = format;
  const buffer = Buffer.from(body.audio, 'base64');
  if (buffer.length > LIMIT_AUDIO) throw new WebError(413, 'Ce vocal est trop volumineux.');
  const header = extension === 'm4a' ? buffer.toString('ascii', 4, 8) : buffer.subarray(0, 4).toString('hex');
  if (header !== signature) throw bad('Le format du vocal est invalide.');
  return { buffer, extension, type };
}

function createAccountApi(store, tutor, options) {
  if (!store) return (_, res) => reply(res, 503, { error: 'L’espace Web est temporairement indisponible.' });
  const auth = createAuth(store, options);
  const rates = new Map();
  const busy = new Set();
  let cleanupAt = 0;

  function throttle(key, limit, duration) {
    const now = Date.now();
    if (now >= cleanupAt) {
      for (const [id, rate] of rates) if (rate.until <= now) rates.delete(id);
      cleanupAt = now + 60000;
    }
    let rate = rates.get(key);
    if (!rate || rate.until <= now) {
      rate = { count: 0, until: now + duration };
      rates.set(key, rate);
    }
    if (++rate.count > limit) throw new WebError(429, 'Trop de demandes. Réessaie dans quelques minutes.');
  }

  async function requireAccount(req) {
    const account = await auth.getAccount(req);
    if (!account) throw new WebError(401, 'Connecte-toi pour continuer.');
    return account;
  }

  async function textToSpeech(text, level) {
    try { return (await tutor.generateSpeech(text, { slow: level !== 'advanced' }))?.toString('base64') || null; }
    catch { return null; }
  }

  async function listTurns(accountId, id, limit = 50, before = null) {
    if (!validId(id)) throw bad('Conversation invalide.');
    if (before !== null && !validId(before)) throw bad('Repère de conversation invalide.');
    const { rows } = await store.query(`
      SELECT id, message, reply, seconds, created_at FROM (
        SELECT t.id, t.message, t.reply, t.seconds, t.created_at
        FROM englishmate_web.turns t JOIN englishmate_web.conversations c ON c.id = t.conversation_id
        WHERE c.id = $1 AND c.account_id = $2 AND
          ($4::uuid IS NULL OR (t.created_at, t.id) < (
            SELECT cursor.created_at, cursor.id FROM englishmate_web.turns cursor
            WHERE cursor.id = $4 AND cursor.conversation_id = c.id
          ))
        ORDER BY t.created_at DESC, t.id DESC LIMIT $3
      ) recent ORDER BY created_at, id`, [id, accountId, limit, before]);
    return rows;
  }

  async function recentTurns(accountId, limit = 9) {
    const { rows } = await store.query(`
      SELECT message, reply FROM (
        SELECT t.message, t.reply, t.created_at, t.id FROM englishmate_web.turns t
        JOIN englishmate_web.conversations c ON c.id = t.conversation_id
        WHERE c.account_id = $1 ORDER BY t.created_at DESC, t.id DESC LIMIT $2
      ) recent ORDER BY created_at, id`, [accountId, limit]);
    return rows;
  }

  async function sendTurn(account, body) {
    if (!account.preferences) throw new WebError(409, 'Configure tes préférences pour commencer.');
    const { conversationId, turnId, mode } = body;
    if (!validId(conversationId) || !validId(turnId) || !['text', 'voice'].includes(mode)) throw bad('Message invalide.');
    throttle(`send:${account.id}`, 10, 60000);
    if (busy.has(account.id)) throw new WebError(409, 'Une réponse est déjà en cours.');
    if (busy.size >= 12) throw new WebError(503, 'Le coach est très sollicité. Réessaie bientôt.');
    busy.add(account.id);
    try {
      const saved = await store.query(`
        SELECT t.id, t.message, t.reply, t.spoken, t.seconds FROM englishmate_web.turns t
        JOIN englishmate_web.conversations c ON c.id = t.conversation_id
        WHERE t.id = $1 AND c.id = $2 AND c.account_id = $3`, [turnId, conversationId, account.id]);
      if (saved.rows[0]) {
        const { spoken, ...turn } = saved.rows[0];
        return { turn, audio: mode === 'voice' ? await textToSpeech(spoken, account.preferences?.level) : null };
      }
      const existing = await store.query('SELECT mode FROM englishmate_web.conversations WHERE id = $1 AND account_id = $2', [conversationId, account.id]);
      if (existing.rows[0] && existing.rows[0].mode !== mode) throw bad('Format incompatible avec cette conversation.');
      let message;
      let seconds = 0;
      const past = await recentTurns(account.id, 9);
      if (mode === 'voice') {
        const audio = decodeAudio(body);
        let transcript;
        try { transcript = await tutor.transcribeAudio(audio.buffer, audio.extension, audio.type, past.at(-1)?.reply || ''); }
        catch { throw new WebError(502, 'La transcription a échoué. Réessaie avec ton enregistrement.'); }
        message = transcript?.trim().slice(0, 1500);
        if (!message) throw new WebError(422, 'Je n’ai pas bien entendu ton vocal. Parle un peu plus fort, près du micro, puis réessaie.');
        seconds = Math.max(1, Math.min(45, Math.round(Number(body.seconds) || 1)));
      } else {
        message = typeof body.text === 'string' ? body.text.trim() : '';
        if (!message || message.length > 1500) throw bad('Écris un message de 1 à 1 500 caractères.');
      }
      const history = past.flatMap(turn => [{ role: 'user', content: turn.message }, { role: 'assistant', content: turn.reply }]);
      let result;
      try { result = await tutor.replyToSession({ ...account.preferences, history, inputMode: mode }, message, 'web'); }
      catch { throw new WebError(502, 'Le coach ne répond pas pour le moment. Réessaie.'); }
      const turn = await store.transaction(async client => {
        await client.query(`INSERT INTO englishmate_web.conversations (id, account_id, title, mode)
          VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`, [conversationId, account.id, message.slice(0, 72), mode]);
        const ownership = await client.query(`UPDATE englishmate_web.conversations SET updated_at = now()
          WHERE id = $1 AND account_id = $2 AND mode = $3`, [conversationId, account.id, mode]);
        if (!ownership.rowCount) throw missing();
        const { rows } = await client.query(`INSERT INTO englishmate_web.turns (id, conversation_id, message, reply, spoken, seconds)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, message, reply, seconds, created_at`,
        [turnId, conversationId, message, result.fullText, result.spokenEnglish, seconds]);
        return rows[0];
      });
      return { turn, audio: mode === 'voice' ? await textToSpeech(result.spokenEnglish, account.preferences?.level) : null };
    } finally {
      busy.delete(account.id);
    }
  }

  const publicRoutes = new Set(['available', 'register', 'login', 'recover', 'logout', 'supabase-session']);
  return async (req, res, route, url) => {
    try {
      const forwarded = req.headers['x-forwarded-for'];
      const address = typeof forwarded === 'string' ? forwarded.split(',').at(-1).trim() : req.socket.remoteAddress;
      throttle(`ip:${address}`, 180, 60000);
      if (publicRoutes.has(route)) {
        if (req.method !== 'POST') throw new WebError(405, 'Méthode indisponible.');
        const body = await parseBody(req, route === 'supabase-session' ? 12288 : 4096);
        const username = normalizeUsername(body.username).slice(0, 24);
        if (route === 'available') {
          throttle(`available:${address}`, 30, 60000);
          return reply(res, 200, await auth.available(body));
        }
        if (route === 'logout') return reply(res, 200, await auth.logout(req, res));
        throttle(`auth-ip:${address}`, 24, 60000);
        if (route === 'supabase-session') return reply(res, 200, await auth.supabaseSession(body, req, res));
        if (route !== 'login') throw new WebError(410, 'Crée ton compte avec ton adresse email.');
        throttle(`auth-user:${username}`, 8, 300000);
        if (route === 'register') return reply(res, 201, await auth.register(body, res));
        if (route === 'login') return reply(res, 200, await auth.login(body, req, res));
        return reply(res, 200, await auth.recover(body, res));
      }
      const account = await requireAccount(req);
      const id = account.id;
      if (req.method === 'GET') {
        if (route === 'me') return reply(res, 200, { account: publicAccount(account) });
        if (route === 'conversations') {
          const { rows } = await store.query(`SELECT id, title, mode, updated_at FROM englishmate_web.conversations
            WHERE account_id = $1 ORDER BY updated_at DESC`, [id]);
          return reply(res, 200, { conversations: rows });
        }
        if (route === 'turns') {
          const conversation = url.searchParams.get('conversation');
          if (!validId(conversation)) throw bad('Conversation invalide.');
          const owner = await store.query('SELECT 1 FROM englishmate_web.conversations WHERE id = $1 AND account_id = $2', [conversation, id]);
          if (!owner.rowCount) throw missing();
          const turns = await listTurns(id, conversation, 51, url.searchParams.get('before'));
          return reply(res, 200, { turns: turns.slice(-50), more: turns.length > 50 });
        }
        if (route === 'vocabulary') {
          const { rows } = await store.query('SELECT id, term, note FROM englishmate_web.vocabulary WHERE account_id = $1 ORDER BY created_at DESC', [id]);
          return reply(res, 200, { words: rows });
        }
        if (route === 'admin') {
          if (!isAdmin(account)) throw missing();
          const totals = await store.query(`SELECT
            (SELECT count(*)::int FROM englishmate_web.accounts) AS users,
            (SELECT count(*)::int FROM englishmate_web.accounts WHERE preferences IS NOT NULL) AS onboarded,
            (SELECT count(*)::int FROM englishmate_web.accounts WHERE created_at >= now() - interval '1 day') AS new_today,
            (SELECT count(*)::int FROM englishmate_web.accounts WHERE created_at >= now() - interval '7 days') AS new_week,
            (SELECT count(*)::int FROM englishmate_web.accounts WHERE created_at >= now() - interval '30 days') AS new_month,
            (SELECT count(DISTINCT c.account_id)::int FROM englishmate_web.turns t JOIN englishmate_web.conversations c ON c.id = t.conversation_id
              WHERE t.created_at >= now() - interval '1 day') AS active_today,
            (SELECT count(DISTINCT c.account_id)::int FROM englishmate_web.turns t JOIN englishmate_web.conversations c ON c.id = t.conversation_id
              WHERE t.created_at >= now() - interval '7 days') AS active_week,
            (SELECT count(*)::int FROM englishmate_web.turns) AS messages,
            (SELECT count(*)::int FROM englishmate_web.turns WHERE seconds > 0) AS voice_messages,
            (SELECT coalesce(sum(seconds), 0)::int FROM englishmate_web.turns) AS voice_seconds,
            (SELECT count(*)::int FROM englishmate_web.vocabulary) AS words`);
          const signups = await store.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, count(a.id)::int AS users
            FROM generate_series(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '13 days', date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day') day
            LEFT JOIN englishmate_web.accounts a ON date_trunc('day', a.created_at AT TIME ZONE 'UTC') = day
            GROUP BY day ORDER BY day`);
          const latest = await store.query(`SELECT a.username AS email, a.created_at, a.preferences->>'level' AS level,
            count(t.id)::int AS messages, max(t.created_at) AS last_active
            FROM englishmate_web.accounts a
            LEFT JOIN englishmate_web.conversations c ON c.account_id = a.id
            LEFT JOIN englishmate_web.turns t ON t.conversation_id = c.id
            GROUP BY a.id ORDER BY a.created_at DESC LIMIT 50`);
          let telegram = null;
          try {
            const tg = await store.query(`SELECT
              count(*)::int AS users,
              count(*) FILTER (WHERE first_seen >= now() - interval '1 day')::int AS new_today,
              count(*) FILTER (WHERE first_seen >= now() - interval '7 days')::int AS new_week,
              count(*) FILTER (WHERE last_seen >= now() - interval '1 day')::int AS active_today,
              count(*) FILTER (WHERE last_seen >= now() - interval '7 days')::int AS active_week,
              coalesce(sum(messages), 0)::int AS messages,
              coalesce(sum(voice_messages), 0)::int AS voice_messages
              FROM englishmate_private.telegram_users`);
            const tgDays = await store.query(`SELECT to_char(day, 'YYYY-MM-DD') AS day, count(u.telegram_id)::int AS users
              FROM generate_series(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '13 days', date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day') day
              LEFT JOIN englishmate_private.telegram_users u ON date_trunc('day', u.first_seen AT TIME ZONE 'UTC') = day
              GROUP BY day ORDER BY day`);
            const tgLatest = await store.query(`SELECT telegram_id::text AS id, first_name, last_name, username, language_code, level,
              first_seen, last_seen, messages, voice_messages
              FROM englishmate_private.telegram_users ORDER BY coalesce(last_seen, first_seen) DESC LIMIT 100`);
            telegram = { ...tg.rows[0], signups: tgDays.rows, latest: tgLatest.rows };
          } catch {
            try {
              const total = (await store.query('SELECT count(*)::int AS total FROM englishmate_private.admin_activity')).rows[0].total;
              telegram = { users: total, new_today: null, new_week: null, active_today: null, active_week: null, messages: null, voice_messages: null, signups: [], latest: [] };
            } catch {}
          }
          return reply(res, 200, { ...totals.rows[0], telegram, signups: signups.rows, latest: latest.rows });
        }
        if (route === 'dashboard') {
          const stats = await store.query(`SELECT
            (SELECT count(*)::int FROM englishmate_web.conversations WHERE account_id = $1) AS conversations,
            (SELECT count(*)::int FROM englishmate_web.vocabulary WHERE account_id = $1) AS words,
            coalesce(sum(t.seconds), 0)::int AS seconds,
            count(t.id)::int AS messages
            FROM englishmate_web.turns t JOIN englishmate_web.conversations c ON c.id = t.conversation_id WHERE c.account_id = $1`, [id]);
          const activity = await store.query(`SELECT to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
            count(*)::int AS messages, sum(t.seconds)::int AS seconds
            FROM englishmate_web.turns t JOIN englishmate_web.conversations c ON c.id = t.conversation_id
            WHERE c.account_id = $1 AND t.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '6 days'
            GROUP BY 1 ORDER BY 1`, [id]);
          return reply(res, 200, { ...stats.rows[0], activity: activity.rows });
        }
        throw missing();
      }
      if (req.method !== 'POST') throw new WebError(405, 'Méthode indisponible.');
      const body = await parseBody(req, route === 'turn' ? Math.ceil(LIMIT_AUDIO / 3) * 4 + 4096 : 8192);
      if (route === 'delete-account') {
        throttle(`delete:${id}`, 5, 300000);
        return reply(res, 200, await auth.deleteAccount(account, body, res));
      }
      if (route === 'preferences') {
        const value = preferences(body);
        await store.query('UPDATE englishmate_web.accounts SET preferences = $1 WHERE id = $2', [JSON.stringify(value), id]);
        return reply(res, 200, { account: publicAccount({ ...account, preferences: value }) });
      }
      if (route === 'turn') return reply(res, 200, await sendTurn(account, body));
      if (route === 'audio') {
        if (!validId(body.turnId)) throw bad('Réponse invalide.');
        throttle(`audio:${id}`, 8, 60000);
        const { rows } = await store.query(`SELECT t.spoken FROM englishmate_web.turns t
          JOIN englishmate_web.conversations c ON c.id = t.conversation_id
          WHERE t.id = $1 AND c.account_id = $2`, [body.turnId, id]);
        if (!rows[0]) throw missing();
        const audio = await textToSpeech(rows[0].spoken, account.preferences?.level);
        if (!audio) throw new WebError(502, 'La réponse audio est temporairement indisponible.');
        return reply(res, 200, { audio });
      }
      if (route === 'vocabulary') {
        const term = typeof body.term === 'string' ? body.term.trim().toLowerCase() : '';
        const note = typeof body.note === 'string' ? body.note.trim() : '';
        if (!term || term.length > 100 || note.length > 500) throw bad('Vérifie le mot et sa définition.');
        const { rows } = await store.query(`INSERT INTO englishmate_web.vocabulary (id, account_id, term, note)
          VALUES ($1, $2, $3, $4) ON CONFLICT (account_id, term) DO UPDATE SET note = excluded.note
          RETURNING id, term, note`, [randomUUID(), id, term, note]);
        return reply(res, 200, { word: rows[0] });
      }
      if (route === 'delete-word') {
        if (!validId(body.id)) throw bad('Mot invalide.');
        await store.query('DELETE FROM englishmate_web.vocabulary WHERE id = $1 AND account_id = $2', [body.id, id]);
        return reply(res, 200, { ok: true });
      }
      throw missing();
    } catch (error) {
      if (error instanceof WebError) return reply(res, error.status, { error: error.message });
      console.warn('[web-api]', describeFailure(error));
      reply(res, 503, { error: 'Le service est temporairement indisponible. Réessaie.' });
    }
  };
}

module.exports = { createAccountApi };
