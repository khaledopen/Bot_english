const { readFileSync } = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { withSupabaseCertificate } = require('./admin-postgres.cjs');

function createAccountStore(connectionString) {
  if (!connectionString) return null;
  const pool = new Pool({
    connectionString: withSupabaseCertificate(connectionString),
    max: 4, connectionTimeoutMillis: 10000, query_timeout: 10000,
  });
  pool.on('error', () => console.warn('[web-db] Connexion inactive interrompue.'));
  let ready;
  const schema = readFileSync(path.join(__dirname, 'web-account-schema.sql'), 'utf8');

  function initialize() {
    ready ??= pool.query(schema).catch(error => {
      ready = undefined;
      throw error;
    });
    return ready;
  }

  return {
    async query(sql, parameters) {
      await initialize();
      return pool.query(sql, parameters);
    },
    async transaction(work) {
      await initialize();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

module.exports = { createAccountStore };
