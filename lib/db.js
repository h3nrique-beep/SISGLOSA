const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Banco único do sistema: SQLite por padrão, MySQL/MariaDB quando DB_HOST está definido.
const mysql = process.env.DB_HOST ? require('mysql2/promise') : null;
const databaseFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'guias.db');
let db;

async function all(sql, params = [], connection = db) {
  if (mysql) return (await connection.execute(sql, params))[0];
  return connection.prepare(sql).all(...params);
}
async function one(sql, params = [], connection = db) { return (await all(sql, params, connection))[0]; }
async function run(sql, params = [], connection = db) {
  if (mysql) {
    const [result] = await connection.execute(sql, params);
    return { changes: result.affectedRows, lastInsertRowid: result.insertId };
  }
  return connection.prepare(sql).run(...params);
}
async function transaction(work) {
  if (!mysql) {
    db.exec('BEGIN');
    try { const result = await work(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
const isDuplicate = (error) => error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ER_DUP_ENTRY';
// INSERT que ignora registro já existente (chave única), nos dois bancos.
async function insertIgnore(sql, params, connection) {
  try { await run(sql, params, connection); } catch (error) { if (!isDuplicate(error)) throw error; }
}
// Cópia consistente do SQLite (inclui o que ainda está no WAL); no MySQL vale o backup-sisglosa.sh.
function sqliteSnapshot(file) { if (!mysql) db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`); }

async function columns(table) {
  const rows = mysql ? await all(`SHOW COLUMNS FROM ${table}`) : await all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((column) => mysql ? column.Field : column.name));
}

async function initializeDatabase(appVersion) {
  if (!mysql) fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  db = mysql
    ? mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10 })
    : new DatabaseSync(databaseFile);
  if (!mysql) db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const id = mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY';
  const money = mysql ? 'DECIMAL(12,2)' : 'TEXT';
  const createdAt = mysql ? 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' : 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP';
  const text = mysql ? 'VARCHAR(255)' : 'TEXT';
  const longText = 'TEXT';
  const execute = (sql) => mysql ? db.query(sql) : Promise.resolve(db.exec(sql));
  await execute(`CREATE TABLE IF NOT EXISTS users (id ${id}, username ${text} NOT NULL UNIQUE, password_hash ${text} NOT NULL)`);
  await execute(`CREATE TABLE IF NOT EXISTS guides (number ${id}, ocs ${text} NOT NULL, patient ${text} NOT NULL, billed ${money} NOT NULL, specialty ${text} NOT NULL DEFAULT '', crm ${text} NOT NULL DEFAULT '', attendance_number ${text} NOT NULL DEFAULT '', status ${text} NOT NULL DEFAULT 'RASCUNHO', finalized_at ${mysql ? 'TIMESTAMP NULL' : 'TEXT'}, created_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS guide_items (id ${id}, guide_number INT NOT NULL, module ${text} NOT NULL, specification ${text} NOT NULL, specialty ${text} NOT NULL DEFAULT '', crm ${text} NOT NULL DEFAULT '', justification ${longText} NOT NULL, amount ${money} NOT NULL, FOREIGN KEY (guide_number) REFERENCES guides(number))`);
  await execute(`CREATE TABLE IF NOT EXISTS guide_edits (id ${id}, guide_number INT NOT NULL, username ${text} NOT NULL, action ${text} NOT NULL, details ${longText}, created_at ${createdAt}, FOREIGN KEY (guide_number) REFERENCES guides(number))`);
  await execute(`CREATE TABLE IF NOT EXISTS deleted_justifications (id ${id}, fingerprint ${text} NOT NULL UNIQUE, justification ${longText} NOT NULL, deleted_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS hidden_suggestions (id ${id}, fingerprint ${text} NOT NULL UNIQUE, kind ${text} NOT NULL, suggestion ${longText} NOT NULL, created_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS saved_justifications (id ${id}, fingerprint ${text} NOT NULL UNIQUE, justification ${longText} NOT NULL, created_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS system_settings (setting_key ${text} NOT NULL UNIQUE, setting_value ${text} NOT NULL)`);
  await execute(`CREATE TABLE IF NOT EXISTS update_packages (id ${id}, version ${text} NOT NULL, filename ${text} NOT NULL, applied_by ${text} NOT NULL, files ${longText} NOT NULL, created_at ${createdAt})`);
  // Rascunho da guia em edição, um por usuário: sobrevive a fechar a aba e a trocar de máquina.
  // MEDIUMTEXT no MySQL: o TEXT de lá para em 64 KB e o rascunho pode chegar a 500 KB.
  await execute(`CREATE TABLE IF NOT EXISTS guide_drafts (username ${text} NOT NULL UNIQUE, payload ${mysql ? 'MEDIUMTEXT' : 'TEXT'} NOT NULL, updated_at ${createdAt})`);
  // Sessões gravadas no banco: atualização (reinício do serviço) não desloga ninguém no meio da guia. Guarda o hash do cookie, não o cookie.
  await execute(`CREATE TABLE IF NOT EXISTS sessions (token_hash ${text} NOT NULL UNIQUE, user_id INT NOT NULL, username ${text} NOT NULL, expires_at ${mysql ? 'BIGINT' : 'INTEGER'} NOT NULL)`);
  // O SQLite não indexa chave estrangeira sozinho; sem isso cada guia aberta varre todos os itens. (No MySQL o InnoDB já cria.)
  if (!mysql) db.exec('CREATE INDEX IF NOT EXISTS idx_guide_items_guide ON guide_items(guide_number); CREATE INDEX IF NOT EXISTS idx_guide_items_module ON guide_items(module, specification); CREATE INDEX IF NOT EXISTS idx_guide_edits_guide ON guide_edits(guide_number); CREATE INDEX IF NOT EXISTS idx_guides_attendance ON guides(attendance_number)');
  const users = await columns('users');
  if (!users.has('role')) await execute(`ALTER TABLE users ADD COLUMN role ${text} NOT NULL DEFAULT 'user'`);
  if (!users.has('must_change_password')) await execute(`ALTER TABLE users ADD COLUMN must_change_password ${mysql ? 'TINYINT(1)' : 'INTEGER'} NOT NULL DEFAULT 1`);
  const guides = await columns('guides');
  if (!guides.has('status')) { await execute(`ALTER TABLE guides ADD COLUMN status ${text} NOT NULL DEFAULT 'RASCUNHO'`); await execute("UPDATE guides SET status='FINALIZADA'"); }
  if (!guides.has('attendance_number')) await execute(`ALTER TABLE guides ADD COLUMN attendance_number ${text} NOT NULL DEFAULT ''`);
  if (!guides.has('finalized_at')) await execute(`ALTER TABLE guides ADD COLUMN finalized_at ${mysql ? 'TIMESTAMP NULL' : 'TEXT'}`);
  // Cada usuário vê só as próprias guias. As existentes ficam com quem as criou (pelo histórico);
  // sem histórico de um usuário existente, com o primeiro usuário de guias.
  if (!guides.has('owner_id')) {
    await execute('ALTER TABLE guides ADD COLUMN owner_id INT');
    await execute('UPDATE guides SET owner_id=(SELECT u.id FROM guide_edits e JOIN users u ON u.username=e.username WHERE e.guide_number=guides.number ORDER BY e.id LIMIT 1)');
    await execute("UPDATE guides SET owner_id=(SELECT MIN(id) FROM users WHERE role<>'admin') WHERE owner_id IS NULL");
  }
  if (!mysql) db.exec('CREATE INDEX IF NOT EXISTS idx_guides_owner ON guides(owner_id)');
  // Nº da guia informado pelo usuário (sai em "GUIA Nº" no relatório); o number continua sendo o id interno.
  if (!guides.has('guide_code')) await execute(`ALTER TABLE guides ADD COLUMN guide_code ${text} NOT NULL DEFAULT ''`);
  if (!(await columns('guide_edits')).has('details')) await execute(`ALTER TABLE guide_edits ADD COLUMN details ${longText}`);
  const packages = await columns('update_packages');
  if (!packages.has('message')) await execute(`ALTER TABLE update_packages ADD COLUMN message ${longText}`);
  if (!packages.has('kind')) await execute(`ALTER TABLE update_packages ADD COLUMN kind ${text} NOT NULL DEFAULT 'corretiva'`);
  if (!packages.has('backup')) await execute(`ALTER TABLE update_packages ADD COLUMN backup ${text} NOT NULL DEFAULT ''`);
  if (!mysql) db.exec("UPDATE guide_items SET specialty=COALESCE((SELECT specialty FROM guides WHERE number=guide_number), '') WHERE specialty=''; UPDATE guide_items SET crm=COALESCE((SELECT crm FROM guides WHERE number=guide_number), '') WHERE crm='';");
  if (!await one('SELECT setting_key FROM system_settings WHERE setting_key=?', ['app_version'])) await run('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', ['app_version', appVersion]);
}

module.exports = { mysql, all, one, run, transaction, insertIgnore, isDuplicate, sqliteSnapshot, initializeDatabase };
