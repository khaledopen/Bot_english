const { Pool } = require('pg');

function createPostgresActivity(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 3,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
  });
  pool.on('error', () => console.warn('Connexion inactive au registre admin interrompue.'));
  let schema;

  async function query(sql, parameters) {
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
    return pool.query(sql, parameters);
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

module.exports = { createPostgresActivity };
