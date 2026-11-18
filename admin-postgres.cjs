const path = require('node:path');
const { Pool } = require('pg');

function describeFailure(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (/tenant or user not found/i.test(message)) return 'POOLER_USER_NOT_FOUND';
  if (/timeout|timed out/i.test(message)) return 'CONNECTION_OR_QUERY_TIMEOUT';
  if (/invalid url|uri malformed|invalid percent/i.test(message)) return 'INVALID_DATABASE_URL';
  const code = error?.code;
  return typeof code === 'string' && /^(?:[0-9A-Z]{5}|E[A-Z_]+|[A-Z]+(?:_[A-Z]+)+)$/.test(code)
    ? code
    : 'UNKNOWN_DATABASE_ERROR';
}

function withSupabaseCertificate(connectionString) {
  const url = URL.parse(connectionString);
  if (!url?.hostname.endsWith('.pooler.supabase.com')) return connectionString;

  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.set('sslrootcert', path.join(__dirname, 'supabase-prod-ca-2021.crt'));
  return url.toString();
}

function createPostgresActivity(connectionString) {
  const pool = new Pool({
    connectionString: withSupabaseCertificate(connectionString),
    max: 3,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  pool.on('error', () => console.warn('Connexion inactive au registre admin interrompue.'));
  let schema;
  let lastFailure;

  async function query(sql, parameters) {
    try {
      schema ??= pool.query(`
      CREATE SCHEMA IF NOT EXISTS englishmate_private;
      CREATE TABLE IF NOT EXISTS englishmate_private.admin_activity (
        telegram_id bigint PRIMARY KEY,
        announced boolean NOT NULL DEFAULT false
      );
      CREATE TABLE IF NOT EXISTS englishmate_private.telegram_users (
        telegram_id bigint PRIMARY KEY,
        first_name text,
        last_name text,
        username text,
        language_code text,
        level text,
        first_seen timestamptz DEFAULT now(),
        last_seen timestamptz,
        messages integer NOT NULL DEFAULT 0,
        voice_messages integer NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS telegram_users_last_seen ON englishmate_private.telegram_users(last_seen DESC);
      INSERT INTO englishmate_private.telegram_users (telegram_id, first_seen)
        SELECT telegram_id, NULL FROM englishmate_private.admin_activity ON CONFLICT (telegram_id) DO NOTHING;
      `).catch((error) => {
        schema = undefined;
        throw error;
      });
      await schema;
      const result = await pool.query(sql, parameters);
      lastFailure = undefined;
      return result;
    } catch (error) {
      const failure = describeFailure(error);
      if (failure !== lastFailure) {
        console.warn(`[admin-db] PostgreSQL indisponible (${failure}).`);
        lastFailure = failure;
      }
      throw error;
    }
  }

  return {
    async needsAnnouncement(id) {
      const { rowCount } = await query(
        `INSERT INTO englishmate_private.admin_activity AS activity (telegram_id) VALUES ($1)
         ON CONFLICT (telegram_id) DO UPDATE SET announced = false
         WHERE activity.announced = false
         RETURNING telegram_id`,
        [id],
      );
      return rowCount > 0;
    },
    async markAnnounced(id) {
      await query('UPDATE englishmate_private.admin_activity SET announced = true WHERE telegram_id = $1', [id]);
    },
    async count() {
      const { rows } = await query('SELECT count(*) AS total FROM englishmate_private.admin_activity');
      return rows[0].total;
    },
    async track(user, { messages = 0, voice = 0, level = null } = {}) {
      const clean = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
      await query(
        `INSERT INTO englishmate_private.telegram_users AS u
           (telegram_id, first_name, last_name, username, language_code, level, last_seen, messages, voice_messages)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8)
         ON CONFLICT (telegram_id) DO UPDATE SET
           first_name = coalesce(excluded.first_name, u.first_name),
           last_name = excluded.last_name,
           username = excluded.username,
           language_code = coalesce(excluded.language_code, u.language_code),
           level = coalesce(excluded.level, u.level),
           last_seen = now(),
           messages = u.messages + excluded.messages,
           voice_messages = u.voice_messages + excluded.voice_messages`,
        [user.id, clean(user.first_name, 80), clean(user.last_name, 80), clean(user.username, 40),
          clean(user.language_code, 12), level, messages, voice],
      );
    },
  };
}

module.exports = { createPostgresActivity, describeFailure, withSupabaseCertificate };
