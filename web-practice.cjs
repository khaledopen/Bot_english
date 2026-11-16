const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const MAX_SESSIONS = 600;
const WINDOW_MS = 60 * 1000;
const SESSION_TTL = 30 * WINDOW_MS;
const LEVELS = new Set(['beginner', 'intermediate', 'advanced']);
const AUDIO_TYPES = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
};

function createWebPractice(tutor, configuredOrigins = '') {
  const origins = new Set(configuredOrigins.split(',').map(value => value.trim()).filter(Boolean));
  const sessions = new Map();
  const rates = new Map();
  let active = 0;
  setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (!session.busy && now - session.touched >= SESSION_TTL) sessions.delete(key);
    }
    for (const [key, rate] of rates) if (rate.until <= now) rates.delete(key);
  }, WINDOW_MS).unref();

  function limited(key, maximum, now) {
    let rate = rates.get(key);
    if (!rate || rate.until <= now) {
      rate = { count: 0, until: now + WINDOW_MS };
      rates.set(key, rate);
    }
    return ++rate.count > maximum;
  }

  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  return async function webPractice(req, res) {
    const origin = req.headers.origin;
    if (origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS' && origins.has(origin)) {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (req.method !== 'POST') return reply(res, 405, { error: 'Méthode non disponible.' });
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
      return reply(res, 415, { error: 'Format de requête non pris en charge.' });
    }

    const now = Date.now();
    const forwarded = req.headers['x-forwarded-for'];
    const address = typeof forwarded === 'string' ? forwarded.split(',').at(-1).trim() : req.socket.remoteAddress;
    if (limited('global', 90, now) || limited(`ip:${address}`, 25, now)) {
      return reply(res, 429, { error: 'Trop de demandes. Réessaie dans une minute.' });
    }

    const bodyLimit = Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 4096;
    if (Number(req.headers['content-length']) > bodyLimit) {
      return reply(res, 413, { error: 'Ce vocal est trop volumineux.' });
    }
    let input;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > bodyLimit) return reply(res, 413, { error: 'Ce vocal est trop volumineux.' });
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return reply(res, 400, { error: 'Ce message ne peut pas être lu.' });
    }
    const { sessionId, level, text, audio, mimeType } = input ?? {};
    if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/i.test(sessionId) || !LEVELS.has(level)) {
      return reply(res, 400, { error: 'Session ou niveau invalide.' });
    }
    const audioType = typeof mimeType === 'string' && mimeType.split(';')[0].toLowerCase();
    const extension = Object.hasOwn(AUDIO_TYPES, audioType) && AUDIO_TYPES[audioType];
    const validText = typeof text === 'string' && text.trim() && text.length <= 1500;
    const validAudio = typeof audio === 'string' && audio.length && extension && /^[A-Za-z0-9+/]+={0,2}$/.test(audio);
    if ((!validText && !validAudio) || (text != null && audio != null)) {
      return reply(res, 400, { error: 'Écris un message de 1 500 caractères maximum ou envoie un vocal.' });
    }
    if (limited(`session:${sessionId}`, 8, now)) return reply(res, 429, { error: 'Réessaie dans une minute.' });
    if (active >= 12 || (!sessions.has(sessionId) && sessions.size >= MAX_SESSIONS)) {
      return reply(res, 503, { error: 'Le coach est très sollicité. Réessaie bientôt.' });
    }
    const session = sessions.get(sessionId) ?? { history: [], touched: now, busy: false };
    if (session.busy) return reply(res, 409, { error: 'Attends la réponse en cours.' });
    if (now - session.touched >= SESSION_TTL) session.history.length = 0;
    session.touched = now;
    session.busy = true;
    sessions.set(sessionId, session);
    active++;
    try {
      let message = validText ? text.trim() : '';
      if (validAudio) {
        const buffer = Buffer.from(audio, 'base64');
        if (buffer.length > MAX_AUDIO_BYTES) return reply(res, 413, { error: 'Ce vocal est trop volumineux.' });
        const header = extension === 'm4a' ? buffer.toString('ascii', 4, 8) : buffer.subarray(0, 4).toString('hex');
        const expectedHeader = { webm: '1a45dfa3', ogg: '4f676753', m4a: 'ftyp', wav: '52494646' }[extension];
        if (header !== expectedHeader || (extension === 'wav' && buffer.toString('ascii', 8, 12) !== 'WAVE')) {
          return reply(res, 400, { error: 'Ce fichier ne correspond pas au format audio annoncé.' });
        }
        message = (await tutor.transcribeAudio(buffer, extension, audioType)).trim();
        if (!message) return reply(res, 422, { error: 'Aucune parole détectée. Essaie un autre enregistrement.' });
        message = message.slice(0, 1500);
      }
      const result = await tutor.replyToSession({ level, history: session.history }, message, 'web');
      let audioReply = null;
      if (validAudio && result.spokenEnglish) {
        audioReply = (await tutor.generateSpeech(result.spokenEnglish))?.toString('base64') ?? null;
      }
      reply(res, 200, { ...result, transcript: validAudio ? message : null, audio: audioReply });
    } catch {
      reply(res, 502, { error: 'Le coach ne répond pas pour le moment. Réessaie.' });
    } finally {
      session.busy = false;
      session.touched = Date.now();
      active--;
    }
  };
}

module.exports = { createWebPractice };
