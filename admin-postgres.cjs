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
      )
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
  };
}

module.exports = { createPostgresActivity, describeFailure, withSupabaseCertificate };
