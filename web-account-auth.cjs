const { argon2, createHash, randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');

const derive = promisify(argon2);
const saltSize = 16;
const options = { parallelism: 1, tagLength: 32, memory: 19456, passes: 2 };
const usernamePattern = /^[a-z0-9_]{3,24}$/;
const normalizeUsername = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validPassword = value => typeof value === 'string' && value.length >= 10 && value.length <= 128;
const digest = value => createHash('sha256').update(value).digest('hex');
const COOKIE = 'englishmate_session';
const SESSION_SECONDS = 14 * 24 * 60 * 60;
let hashes = 0;
const SUPABASE_HASH = 'supabase-auth';
const supabaseUrl = () => (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const supabaseKey = () => (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '').trim();

class WebError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function passwordKey(password, nonce) {
  if (hashes >= 4) throw new WebError(429, 'Trop de demandes. Réessaie dans un instant.');
  hashes++;
  try {
    return await derive('argon2id', { ...options, message: password, nonce });
  } finally {
    hashes--;
  }
}

async function hashPassword(password) {
  const salt = randomBytes(saltSize);
  const key = await passwordKey(password, salt);
  return `argon2id$v1$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, hash) {
  if (!validPassword(password)) return false;
  const [, , salt, expected] = (hash || '').split('$');
  const key = await passwordKey(password, salt ? Buffer.from(salt, 'hex') : Buffer.alloc(saltSize));
  return Boolean(expected && timingSafeEqual(key, Buffer.from(expected, 'hex')));
}

async function supabaseRequest(path, init = {}) {
  const url = supabaseUrl();
  const key = supabaseKey();
  if (!url || !key) throw new WebError(503, 'La connexion par email n’est pas encore configurée.');
  try {
    return await fetch(`${url}/auth/v1/${path}`, {
      ...init,
      headers: { apikey: key, 'Content-Type': 'application/json', ...init.headers },
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new WebError(503, 'Le service de connexion est indisponible. Réessaie.');
  }
}

async function supabaseUser(token) {
  const expired = () => new WebError(401, 'Ta session a expiré. Reconnecte-toi.');
  if (typeof token !== 'string' || token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw expired();
  const response = await supabaseRequest('user', { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403) throw expired();
  if (!response.ok) throw new WebError(503, 'Le service de connexion est indisponible. Réessaie.');
  const user = await response.json().catch(() => null);
  if (!user?.id || typeof user.email !== 'string') throw expired();
  if (!user.email_confirmed_at) throw new WebError(403, 'Confirme ton adresse email avant de te connecter.');
  return user;
}

async function verifySupabasePassword(account, password) {
  if (typeof password !== 'string' || !password || password.length > 128) return false;
  const response = await supabaseRequest('token?grant_type=password', {
    method: 'POST', body: JSON.stringify({ email: account.username, password }),
  });
  if (!response.ok) return false;
  const session = await response.json().catch(() => null);
  return session?.user?.id === account.id;
}

function isAdmin(account) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return Boolean(account?.username && admins.includes(account.username.toLowerCase()));
}

function publicAccount(account) {
  return { username: account.username, preferences: account.preferences, ...(isAdmin(account) ? { admin: true } : {}) };
}

function createAuth(store, { secure = true } = {}) {
  function writeCookie(res, token, age = SESSION_SECONDS) {
    res.setHeader('Set-Cookie',
      `${COOKIE}=${token}; Max-Age=${age}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }

  function tokenHash(req) {
    const token = req.headers.cookie?.split(';').map(part => part.trim())
      .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(token || '') ? digest(token) : null;
  }

  async function createSession(client, id) {
    const token = randomBytes(32).toString('hex');
    await client.query('DELETE FROM englishmate_web.sessions WHERE account_id = $1 AND expires_at <= now()', [id]);
    await client.query(`INSERT INTO englishmate_web.sessions (token_hash, account_id, expires_at)
      VALUES ($1, $2, now() + interval '14 days')`, [digest(token), id]);
    return token;
  }

  async function getAccount(req) {
    const hash = tokenHash(req);
    if (!hash) return null;
    const { rows } = await store.query(`
      SELECT a.id, a.username, a.password_hash, a.preferences FROM englishmate_web.sessions s
      JOIN englishmate_web.accounts a ON a.id = s.account_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`, [hash]);
    return rows[0] || null;
  }

  function validatedCredentials(body) {
    const username = normalizeUsername(body.username);
    if (!usernamePattern.test(username)) throw new WebError(400, 'Utilise 3 à 24 lettres, chiffres ou tirets bas pour ton pseudo.');
    if (!validPassword(body.password)) throw new WebError(400, 'Utilise un mot de passe de 10 à 128 caractères.');
    if (body.password !== body.confirmation) throw new WebError(400, 'Les deux mots de passe doivent être identiques.');
    return username;
  }

  return {
    getAccount,
    async supabaseSession(body, req, res) {
      const user = await supabaseUser(body.accessToken);
      const email = user.email.trim().toLowerCase();
      const result = await store.transaction(async client => {
        await client.query(`UPDATE englishmate_web.accounts SET username = username || '#' || left(id::text, 8)
          WHERE username = $1 AND id <> $2`, [email, user.id]);
        const { rows } = await client.query(`INSERT INTO englishmate_web.accounts (id, username, password_hash)
          VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET username = excluded.username
          RETURNING id, username, preferences`, [user.id, email, SUPABASE_HASH]);
        const previous = tokenHash(req);
        if (previous) await client.query('DELETE FROM englishmate_web.sessions WHERE token_hash = $1', [previous]);
        return { account: rows[0], token: await createSession(client, user.id) };
      });
      writeCookie(res, result.token);
      return { account: publicAccount(result.account) };
    },
    async available(body) {
      const username = normalizeUsername(body.username);
      if (!usernamePattern.test(username)) throw new WebError(400, 'Pseudo invalide.');
      const { rowCount } = await store.query('SELECT 1 FROM englishmate_web.accounts WHERE username = $1', [username]);
      return { available: rowCount === 0 };
    },
    async register(body, res) {
      const username = validatedCredentials(body);
      const id = randomUUID();
      const passwordHash = await hashPassword(body.password);
      const codes = Array.from({ length: 8 }, () => randomBytes(12).toString('hex').match(/.{8}/g).join('-'));
      const token = await store.transaction(async client => {
        const { rowCount } = await client.query(`INSERT INTO englishmate_web.accounts (id, username, password_hash)
          VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING`, [id, username, passwordHash]);
        if (!rowCount) throw new WebError(409, 'Ce pseudo est déjà pris.');
        await client.query(`INSERT INTO englishmate_web.recovery_codes (account_id, code_hash)
          SELECT $1, unnest($2::text[])`, [id, codes.map(digest)]);
        return createSession(client, id);
      });
      writeCookie(res, token);
      return { account: { username, preferences: null }, codes };
    },
    async login(body, req, res) {
      const { rows } = await store.query('SELECT * FROM englishmate_web.accounts WHERE username = $1', [normalizeUsername(body.username)]);
      const account = rows[0];
      if (!await verifyPassword(body.password, account?.password_hash)) throw new WebError(401, 'Pseudo ou mot de passe incorrect.');
      const token = await store.transaction(async client => {
        const current = await client.query('SELECT password_hash FROM englishmate_web.accounts WHERE id = $1 FOR UPDATE', [account.id]);
        if (current.rows[0]?.password_hash !== account.password_hash) throw new WebError(401, 'Identifiants modifiés. Réessaie.');
        await client.query('DELETE FROM englishmate_web.sessions WHERE token_hash = $1', [tokenHash(req)]);
        return createSession(client, account.id);
      });
      writeCookie(res, token);
      return { account: publicAccount(account) };
    },
    async recover(body, res) {
      const username = validatedCredentials(body);
      const code = typeof body.code === 'string' ? body.code.trim().toLowerCase() : '';
      const invalidCode = () => new WebError(400, 'Ce code de récupération est invalide ou a déjà été utilisé.');
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{8}){2}$/.test(code)) throw invalidCode();
      const hashed = await hashPassword(body.password);
      const recovered = await store.transaction(async client => {
        const { rows } = await client.query('SELECT id, username, preferences FROM englishmate_web.accounts WHERE username = $1 FOR UPDATE', [username]);
        const account = rows[0];
        if (!account) throw invalidCode();
        const { rowCount } = await client.query('DELETE FROM englishmate_web.recovery_codes WHERE account_id = $1 AND code_hash = $2', [account.id, digest(code)]);
        if (!rowCount) throw invalidCode();
        await client.query('UPDATE englishmate_web.accounts SET password_hash = $1 WHERE id = $2', [hashed, account.id]);
        await client.query('DELETE FROM englishmate_web.sessions WHERE account_id = $1', [account.id]);
        return { account, token: await createSession(client, account.id) };
      });
      writeCookie(res, recovered.token);
      return { account: publicAccount(recovered.account) };
    },
    async logout(req, res) {
      await store.query('DELETE FROM englishmate_web.sessions WHERE token_hash = $1', [tokenHash(req)]);
      writeCookie(res, '', 0);
      return { ok: true };
    },
    async deleteAccount(account, body, res) {
      const valid = account.password_hash === SUPABASE_HASH
        ? await verifySupabasePassword(account, body.password)
        : await verifyPassword(body.password, account.password_hash);
      if (!valid) throw new WebError(401, 'Mot de passe incorrect.');
      const { rowCount } = await store.query('DELETE FROM englishmate_web.accounts WHERE id = $1 AND password_hash = $2', [account.id, account.password_hash]);
      if (!rowCount) throw new WebError(409, 'Les identifiants ont changé. Réessaie.');
      writeCookie(res, '', 0);
      const secret = (process.env.SUPABASE_SECRET_KEY || '').trim();
      if (account.password_hash === SUPABASE_HASH && secret) {
        await supabaseRequest(`admin/users/${account.id}`, { method: 'DELETE', headers: { apikey: secret } }).catch(() => null);
      }
      return { ok: true };
    },
  };
}

module.exports = { createAuth, publicAccount, isAdmin, WebError, normalizeUsername };
