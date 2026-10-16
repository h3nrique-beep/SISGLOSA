// Copia todo o banco SQLite (data/guias.db) para o MySQL/MariaDB configurado em DB_*.
// Antes, inicie o SISGLOSA uma vez com as variáveis DB_* definidas: ele cria as tabelas no MySQL.
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const mysql = require('mysql2/promise');

if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) throw new Error('Defina DB_HOST, DB_USER, DB_PASSWORD e DB_NAME antes de migrar.');

// Ordem respeita as chaves estrangeiras (guias antes dos itens e do histórico).
const TABLES = ['users', 'guides', 'guide_items', 'guide_edits', 'deleted_justifications', 'saved_justifications', 'hidden_suggestions', 'system_settings', 'update_packages', 'guide_drafts'];

(async () => {
  const source = new DatabaseSync(process.env.SQLITE_FILE || path.join(__dirname, '..', 'data', 'guias.db'), { readOnly: true });
  const target = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
  await target.beginTransaction();
  try {
    for (const table of TABLES) {
      if (!source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const [targetColumns] = await target.query(`SHOW COLUMNS FROM ${table}`);
      const allowed = new Set(targetColumns.map((column) => column.Field));
      const columns = source.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name).filter((name) => allowed.has(name));
      const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ${columns.map((name) => `${name}=VALUES(${name})`).join(', ')}`;
      const rows = source.prepare(`SELECT ${columns.join(', ')} FROM ${table}`).all();
      for (const row of rows) await target.execute(sql, columns.map((name) => row[name]));
      console.log(`${table}: ${rows.length} registro(s)`);
    }
    await target.commit();
    console.log('Migração concluída.');
  } catch (error) { await target.rollback(); throw error; } finally { await target.end(); source.close(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
