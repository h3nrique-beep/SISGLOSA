const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { DatabaseSync } = require('node:sqlite');
const mysql = process.env.DB_HOST ? require('mysql2/promise') : null;
const { hashPassword, passwordMatches, strongPassword, temporaryPassword } = require('./lib/passwords');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const MODULES = [
  'Ajuste de honorários', 'Ajuste de exame laboratorial', 'Ajuste de exame de imagem',
  'Glosa de honorário médico', 'Glosa de taxa', 'Glosa de material', 'Glosa de medicamento',
  'Glosa de exame de imagem', 'Glosa de exame laboratorial', 'Glosa de nutrição', 'Glosa de OPME', 'Glosa de fisioterapia',
];
const FINALIZED_EDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_ADJUSTMENT_JUSTIFICATION = 'Ajuste, será pago R$ conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.';
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MAX_BODY_SIZE = 1_000_000;
const MAX_UPDATE_SIZE = 25 * 1024 * 1024;
const pacote = require('./lib/pacote');
const UPDATE_FILES = new Set(pacote.UPDATE_FILES);
const APP_VERSION = require('./package.json').version;
const UPDATE_BACKUP_ROOT = process.env.UPDATE_BACKUP_ROOT || path.join(ROOT, 'data', 'updates', 'backups');
let db;
const databaseFile = process.env.DB_FILE || path.join(ROOT, 'data', 'guias.db');
const reportLogo = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'public', 'template-logo.png')).toString('base64')}`;

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
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
async function initializeDatabase() {
  if (!mysql) fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  db = mysql ? mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10 }) : new DatabaseSync(databaseFile);
  if (!mysql) db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const id = mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY';
  const money = mysql ? 'DECIMAL(12,2)' : 'TEXT';
  const createdAt = mysql ? 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' : 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP';
  const text = mysql ? 'VARCHAR(255)' : 'TEXT';
  const longText = mysql ? 'TEXT' : 'TEXT';
  const execute = (sql) => mysql ? db.query(sql) : Promise.resolve(db.exec(sql));
  await execute(`CREATE TABLE IF NOT EXISTS users (id ${id}, username ${text} NOT NULL UNIQUE, password_hash ${text} NOT NULL)`);
  await execute(`CREATE TABLE IF NOT EXISTS guides (number ${id}, ocs ${text} NOT NULL, patient ${text} NOT NULL, billed ${money} NOT NULL, specialty ${text} NOT NULL DEFAULT '', crm ${text} NOT NULL DEFAULT '', attendance_number ${text} NOT NULL DEFAULT '', status ${text} NOT NULL DEFAULT 'RASCUNHO', finalized_at ${mysql ? 'TIMESTAMP NULL' : 'TEXT'}, created_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS guide_items (id ${id}, guide_number INT NOT NULL, module ${text} NOT NULL, specification ${text} NOT NULL, specialty ${text} NOT NULL DEFAULT '', crm ${text} NOT NULL DEFAULT '', justification ${longText} NOT NULL, amount ${money} NOT NULL, FOREIGN KEY (guide_number) REFERENCES guides(number))`);
  await execute(`CREATE TABLE IF NOT EXISTS guide_edits (id ${id}, guide_number INT NOT NULL, username ${text} NOT NULL, action ${text} NOT NULL, details ${longText}, created_at ${createdAt}, FOREIGN KEY (guide_number) REFERENCES guides(number))`);
  await execute(`CREATE TABLE IF NOT EXISTS deleted_justifications (id ${id}, fingerprint ${text} NOT NULL UNIQUE, justification ${longText} NOT NULL, deleted_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS saved_justifications (id ${id}, fingerprint ${text} NOT NULL UNIQUE, justification ${longText} NOT NULL, created_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS system_settings (setting_key ${text} NOT NULL UNIQUE, setting_value ${text} NOT NULL)`);
  await execute(`CREATE TABLE IF NOT EXISTS update_packages (id ${id}, version ${text} NOT NULL, filename ${text} NOT NULL, applied_by ${text} NOT NULL, files ${longText} NOT NULL, created_at ${createdAt})`);
  // O SQLite não indexa chave estrangeira sozinho; sem isso cada guia aberta varre todos os itens. (No MySQL o InnoDB já cria.)
  if (!mysql) db.exec('CREATE INDEX IF NOT EXISTS idx_guide_items_guide ON guide_items(guide_number); CREATE INDEX IF NOT EXISTS idx_guide_items_module ON guide_items(module, specification); CREATE INDEX IF NOT EXISTS idx_guide_edits_guide ON guide_edits(guide_number)');
  const userColumns = mysql ? await all('SHOW COLUMNS FROM users') : await all('PRAGMA table_info(users)');
  const names = new Set(userColumns.map((column) => mysql ? column.Field : column.name));
  if (!names.has('role')) await execute(`ALTER TABLE users ADD COLUMN role ${text} NOT NULL DEFAULT 'user'`);
  if (!names.has('must_change_password')) await execute(`ALTER TABLE users ADD COLUMN must_change_password ${mysql ? 'TINYINT(1)' : 'INTEGER'} NOT NULL DEFAULT 1`);
  const guideColumns = mysql ? await all('SHOW COLUMNS FROM guides') : await all('PRAGMA table_info(guides)');
  const guideNames = new Set(guideColumns.map((column) => mysql ? column.Field : column.name));
  if (!guideNames.has('status')) { await execute(`ALTER TABLE guides ADD COLUMN status ${text} NOT NULL DEFAULT 'RASCUNHO'`); await execute("UPDATE guides SET status='FINALIZADA'"); }
  if (!guideNames.has('attendance_number')) await execute(`ALTER TABLE guides ADD COLUMN attendance_number ${text} NOT NULL DEFAULT ''`);
  if (!guideNames.has('finalized_at')) await execute(`ALTER TABLE guides ADD COLUMN finalized_at ${mysql ? 'TIMESTAMP NULL' : 'TEXT'}`);
  const editColumns = mysql ? await all('SHOW COLUMNS FROM guide_edits') : await all('PRAGMA table_info(guide_edits)');
  const editNames = new Set(editColumns.map((column) => mysql ? column.Field : column.name));
  if (!editNames.has('details')) await execute(`ALTER TABLE guide_edits ADD COLUMN details ${longText}`);
  const packageColumns = mysql ? await all('SHOW COLUMNS FROM update_packages') : await all('PRAGMA table_info(update_packages)');
  const packageNames = new Set(packageColumns.map((column) => mysql ? column.Field : column.name));
  if (!packageNames.has('message')) await execute(`ALTER TABLE update_packages ADD COLUMN message ${longText}`);
  if (!packageNames.has('kind')) await execute(`ALTER TABLE update_packages ADD COLUMN kind ${text} NOT NULL DEFAULT 'corretiva'`);
  if (!packageNames.has('backup')) await execute(`ALTER TABLE update_packages ADD COLUMN backup ${text} NOT NULL DEFAULT ''`);
  if (!mysql) db.exec(`UPDATE guide_items SET specialty=COALESCE((SELECT specialty FROM guides WHERE number=guide_number), '') WHERE specialty=''; UPDATE guide_items SET crm=COALESCE((SELECT crm FROM guides WHERE number=guide_number), '') WHERE crm='';`);
  if (!await one('SELECT setting_key FROM system_settings WHERE setting_key=?', ['app_version'])) await run('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', ['app_version', APP_VERSION]);
}

function sessionData(session) { return { username: session.username, role: session.role, mustChangePassword: Boolean(session.mustChangePassword) }; }
function clearUserSessions(username) { for (const [id, session] of sessions) if (session.username === username) sessions.delete(id); }
function pruneSessions() { for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id); }
// Atrás do Nginx toda conexão chega de 127.0.0.1; o proxy grava o IP real em X-Real-IP, aceito só vindo do loopback.
function clientAddress(request) { const ip = request.socket.remoteAddress; return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip) && request.headers['x-real-ip'] ? String(request.headers['x-real-ip']) : (ip || 'unknown'); }
function loginKey(request, username) { return `${clientAddress(request)}:${username.toLowerCase()}`; }
function loginAllowed(key) { const attempts = (loginAttempts.get(key) || []).filter((time) => time > Date.now() - LOGIN_WINDOW_MS); loginAttempts.set(key, attempts); return attempts.length < MAX_LOGIN_ATTEMPTS; }
function registerFailedLogin(key) { loginAttempts.set(key, [...(loginAttempts.get(key) || []).filter((time) => time > Date.now() - LOGIN_WINDOW_MS), Date.now()]); }
function justificationFingerprint(value) { return crypto.createHash('sha256').update(String(value).trim()).digest('hex'); }
// A lista de justificativas varre todos os itens e bloqueava o servidor por centenas de ms: fica em memória até uma gravação a invalidar.
let optionsVersion = 0, justificationCache = null;
async function justificationOptions() {
  const version = optionsVersion; if (justificationCache?.version === version) return justificationCache.value;
  const deleted = new Set((await all('SELECT fingerprint FROM deleted_justifications')).map((row) => row.fingerprint));
  const fromGuides = (await all("SELECT DISTINCT justification FROM guide_items WHERE trim(justification)<>'' AND justification NOT LIKE 'Ajuste, será pago%' ORDER BY justification")).map((row) => row.justification.trim());
  const manuallySaved = (await all('SELECT justification FROM saved_justifications ORDER BY justification')).map((row) => row.justification.trim());
  const saved = [...new Set([...manuallySaved, ...fromGuides])].filter((value) => !deleted.has(justificationFingerprint(value)));
  const value = [...new Set([DEFAULT_ADJUSTMENT_JUSTIFICATION, ...saved])];
  if (version === optionsVersion) justificationCache = { version, value };
  return value;
}
const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
const isHonor = (module) => module.includes('honorário');
const validModule = (module) => MODULES.includes(module) || /^(Ajuste|Glosa):\s+\S/.test(module);
function finalizedDate(value) { if (!value) return null; if (value instanceof Date) return value; const text = String(value); return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`); }
function guideAccess(data) { const finalized = finalizedDate(data.finalized_at); const editableUntil = finalized ? new Date(finalized.getTime() + FINALIZED_EDIT_WINDOW_MS) : null; return { editable: data.status !== 'FINALIZADA' || !editableUntil || Date.now() <= editableUntil.getTime(), editable_until: editableUntil?.toISOString() || null }; }
const cookie = (request, name) => Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim().split('=')))[name];
const securityHeaders = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
const json = (response, status, value, headers = {}) => response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
const fail = (response, status, message) => json(response, status, { error: message });
const authenticated = (request) => { const id = cookie(request, 'PMGU_SESSION'); const session = sessions.get(id); if (!session || session.expires <= Date.now()) { if (id) sessions.delete(id); return null; } return session; };
const sessionCookie = (id, maxAge = null) => `PMGU_SESSION=${id}; ${maxAge === null ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ` : 'Max-Age=0; '}HttpOnly; SameSite=Strict; Path=/${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;

function body(request) {
  return new Promise((resolve, reject) => {
    let data = '', tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => { if (tooLarge) return; if (data.length + chunk.length > MAX_BODY_SIZE) { tooLarge = true; return; } data += chunk; });
    request.on('end', () => { if (tooLarge) return reject(Object.assign(new Error('A solicitação excede o limite permitido.'), { statusCode: 413 })); try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Dados inválidos.')); } });
    request.on('error', reject);
  });
}
function rawBody(request, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    request.on('data', (chunk) => { size += chunk.length; if (size <= maxSize) chunks.push(chunk); });
    request.on('end', () => size > maxSize ? reject(Object.assign(new Error('O pacote excede o limite de 25 MB.'), { statusCode: 413 })) : resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
const updateError = (message) => Object.assign(new Error(message), { statusCode: 400 });
// Cada pacote guarda cópia dos arquivos e do banco; mantém só as mais recentes para não encher o disco.
function pruneUpdateBackups(keep = 10) {
  try {
    const folders = fs.readdirSync(UPDATE_BACKUP_ROOT).filter((name) => /^\d+-[0-9a-f-]{36}$/.test(name)).sort().reverse();
    for (const name of folders.slice(keep)) fs.rmSync(path.join(UPDATE_BACKUP_ROOT, name), { recursive: true, force: true });
  } catch (error) { console.error('Não foi possível limpar cópias antigas de atualização:', error.message); }
}
async function systemInfo() {
  const version = (await one('SELECT setting_value FROM system_settings WHERE setting_key=?', ['app_version']))?.setting_value || APP_VERSION;
  return { version, updates: (await one('SELECT COUNT(*) AS total FROM update_packages')).total };
}
async function updateHistory() { return all('SELECT version, filename, applied_by, files, message, kind, backup, created_at FROM update_packages ORDER BY id DESC LIMIT 20'); }
async function applyUpdatePackage(buffer, filename, username) {
  if (!buffer.length) throw updateError('Selecione um pacote ZIP.');
  let archive;
  try { archive = new AdmZip(buffer); } catch { throw updateError('O arquivo enviado não é um ZIP válido.'); }
  const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
  if (!entries.length || entries.length > UPDATE_FILES.size + 1) throw updateError('O pacote possui uma estrutura inválida.');
  const names = entries.map((entry) => entry.entryName.replaceAll('\\', '/'));
  if (new Set(names).size !== names.length || names.some((name) => name !== 'sisglosa-update.json' && !UPDATE_FILES.has(name))) throw updateError('O pacote contém arquivos não permitidos.');
  if (entries.reduce((total, entry) => total + Number(entry.header.size || 0), 0) > MAX_UPDATE_SIZE) throw updateError('O conteúdo descompactado excede o limite permitido.');
  const manifestEntry = entries.find((entry) => entry.entryName.replaceAll('\\', '/') === 'sisglosa-update.json');
  if (!manifestEntry) throw updateError('Inclua o arquivo sisglosa-update.json no pacote.');
  let manifest;
  try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); } catch { throw updateError('O manifesto do pacote é inválido.'); }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (manifest.product !== 'SISGLOSA' || !pacote.VERSION_PATTERN.test(String(manifest.version || '')) || !files.length || new Set(files).size !== files.length || files.some((file) => !UPDATE_FILES.has(file)) || files.length !== names.filter((name) => name !== pacote.MANIFEST_NAME).length || files.some((file) => !names.includes(file))) throw updateError('O manifesto não corresponde aos arquivos permitidos do SISGLOSA.');
  const message = String(manifest.message || '').trim(), type = String(manifest.type || 'corretiva');
  if (!message || message.length > pacote.MAX_MESSAGE) throw updateError(`Informe a mensagem do pacote (campo "message" do manifesto), com até ${pacote.MAX_MESSAGE} caracteres.`);
  if (!pacote.KINDS.includes(type)) throw updateError(`Tipo de atualização inválido. Use: ${pacote.KINDS.join(', ')}.`);
  const contents = new Map(files.map((file) => [file, entries.find((candidate) => candidate.entryName.replaceAll('\\', '/') === file).getData()]));
  for (const [file, content] of contents) { const problem = pacote.syntaxError(file, content); if (problem) throw updateError(`O arquivo ${file} tem erro de sintaxe (${problem}); o pacote não foi aplicado.`); }
  const backupRoot = path.join(UPDATE_BACKUP_ROOT, `${Date.now()}-${crypto.randomUUID()}`);
  const backedUp = [];
  try {
    for (const file of files) {
      const target = path.join(ROOT, file); if (!fs.existsSync(target)) throw updateError(`Arquivo de destino ausente: ${file}.`);
      const backup = path.join(backupRoot, file); fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(target, backup); backedUp.push(file);
    }
    // Cópia consistente do SQLite antes de o código novo (que pode migrar tabelas ao reiniciar) rodar; no MySQL vale o backup-sisglosa.sh.
    if (!mysql) db.exec(`VACUUM INTO '${path.join(backupRoot, 'guias.db').replaceAll("'", "''")}'`);
    for (const [file, content] of contents) fs.writeFileSync(path.join(ROOT, file), content);
    await transaction(async (connection) => {
      await run('INSERT INTO update_packages (version, filename, applied_by, files, message, kind, backup) VALUES (?, ?, ?, ?, ?, ?, ?)', [manifest.version, filename, username, JSON.stringify(files), message, type, backupRoot], connection);
      await run('UPDATE system_settings SET setting_value=? WHERE setting_key=?', [manifest.version, 'app_version'], connection);
    });
  } catch (error) {
    for (const file of backedUp) fs.copyFileSync(path.join(backupRoot, file), path.join(ROOT, file));
    throw error;
  }
  pruneUpdateBackups();
  return { version: manifest.version, type, message, files, backup: backupRoot, restartRequired: files.some((file) => pacote.RESTART_FILES.includes(file)) };
}
async function guide(id) {
  const data = await one('SELECT number, ocs, patient, billed, attendance_number, status, finalized_at FROM guides WHERE number=?', [id]);
  if (!data) return null;
  data.items = (await all('SELECT module, specification, specialty, crm, justification, amount FROM guide_items WHERE guide_number=? ORDER BY id', [id])).map((item) => ({ ...item, amount: Number(item.amount) }));
  data.billed = Number(data.billed);
  return { ...data, ...guideAccess(data) };
}
async function listGuides(status) { const valid = ['RASCUNHO', 'FINALIZADA'].includes(status); return (await all(`SELECT number, ocs, patient, billed, status, finalized_at, created_at FROM guides${valid ? ' WHERE status=?' : ''} ORDER BY number DESC LIMIT 100`, valid ? [status] : [])).map((item) => ({ ...item, billed: Number(item.billed), ...guideAccess(item) })); }
async function dashboard() { const counts = await one("SELECT COUNT(*) AS total, SUM(CASE WHEN status='RASCUNHO' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status='FINALIZADA' THEN 1 ELSE 0 END) AS finalized FROM guides"); return { total: Number(counts.total || 0), open: Number(counts.open || 0), finalized: Number(counts.finalized || 0), recent: (await listGuides()).slice(0, 5) }; }
function totals(items, billed) {
  const glosa = items.filter((item) => item.module.startsWith('Glosa')).reduce((sum, item) => sum + Number(item.amount), 0);
  const ajuste = items.filter((item) => item.module.startsWith('Ajuste')).reduce((sum, item) => sum + Number(item.amount), 0);
  return { glosa, ajuste, auditado: Number(billed) - glosa + ajuste };
}
function historyText(value) { return String(value ?? '').trim() || 'não informado'; }
function historyStatus(value) { return value === 'FINALIZADA' ? 'Finalizada' : 'Rascunho'; }
function historyItem(item) { return [item.module, item.specification].filter(Boolean).join(' — ') || 'sem identificação'; }
function detailChange(details, label, before, after, format = historyText) { if (String(before ?? '').trim() !== String(after ?? '').trim()) details.push(`${label}: ${format(before)} → ${format(after)}`); }
function guideChanges(previous, previousItems, next) {
  const details = [];
  if (!previous) {
    if (next.ocs) details.push(`OCS definido como ${historyText(next.ocs)}`);
    if (next.patient) details.push(`Paciente definido como ${historyText(next.patient)}`);
    if (next.attendance_number) details.push(`Nº do atendimento definido como ${historyText(next.attendance_number)}`);
    if (Number(next.billed)) details.push(`Valor apresentado definido como ${money(next.billed)}`);
  } else {
    detailChange(details, 'OCS', previous.ocs, next.ocs);
    detailChange(details, 'Paciente', previous.patient, next.patient);
    detailChange(details, 'Nº do atendimento', previous.attendance_number, next.attendance_number);
    detailChange(details, 'Valor apresentado', previous.billed, next.billed, (value) => money(value));
    detailChange(details, 'Situação', previous.status, next.status, historyStatus);
  }
  const total = Math.max(previousItems.length, next.items.length);
  for (let index = 0; index < total; index += 1) {
    const before = previousItems[index], after = next.items[index];
    if (!before) { details.push(`Item ${index + 1} adicionado: ${historyItem(after)}`); continue; }
    if (!after) { details.push(`Item ${index + 1} removido: ${historyItem(before)}`); continue; }
    const itemDetails = [];
    detailChange(itemDetails, 'Módulo', before.module, after.module);
    detailChange(itemDetails, 'Especificação', before.specification, after.specification);
    detailChange(itemDetails, 'Especialidade', before.specialty, after.specialty);
    detailChange(itemDetails, 'CRM', before.crm, after.crm);
    detailChange(itemDetails, 'Justificativa', before.justification, after.justification);
    detailChange(itemDetails, 'Valor', before.amount, after.amount, (value) => money(value));
    if (itemDetails.length) details.push(`Item ${index + 1} (${historyItem(after)}): ${itemDetails.join('; ')}`);
  }
  return details;
}
function historyDetails(value) { try { const details = JSON.parse(value || '[]'); return Array.isArray(details) ? details : []; } catch { return []; } }
function reportPage(data) { return reportPageBody(data).replace('</head>', '<style>@page{size:A4;margin:11.09mm 9.42mm 14.94mm 10.81mm}*{box-sizing:border-box}body{width:auto!important;margin:0!important;padding:0!important}table{max-width:100%!important}h3{border:1px solid #000;border-bottom:0;margin:12px 0 0!important;padding:2px}h3+table{margin-top:0!important}table:not(.summary){table-layout:fixed}table:not(.summary) th:nth-child(1),table:not(.summary) td:nth-child(1){width:5.25%}table:not(.summary) th:nth-child(2),table:not(.summary) td:nth-child(2){width:37.22%}table:not(.summary) th:nth-child(3),table:not(.summary) td:nth-child(3){width:46.84%}table:not(.summary) th:nth-child(4),table:not(.summary) td:nth-child(4){width:10.69%}</style></head>'); }
function reportPageBody(data) {
  const summary = totals(data.items, data.billed);
  const sections = ['Ajuste', 'Glosa'].map((prefix) => {
    const groups = MODULES.filter((module) => module.startsWith(prefix)).map((module) => [module, data.items.filter((item) => item.module === module)]).filter(([, items]) => items.length);
    if (!groups.length) return '';
    return `<h2>RELATÓRIO DE ${prefix.toUpperCase()}</h2>${groups.map(([module, items]) => {
      const honor = isHonor(module); const total = items.reduce((sum, item) => sum + Number(item.amount), 0); const label = module === 'Ajuste de honorários' ? 'Honorários - Ajuste' : module.toUpperCase();
      return `<h3>${escape(label)}</h3><table><thead><tr><th>Item</th><th>Especificação</th><th>Justificativa</th><th>${prefix}</th></tr></thead><tbody>${items.map((item, index) => { const details = [item.specification, honor && item.specialty, honor && item.crm ? `CRM: ${item.crm}` : ''].filter(Boolean).join(' - '); return `<tr><td>${index + 1}</td><td>${escape(details)}</td><td>${escape(item.justification).replaceAll('\n', '<br>')}</td><td class="money">${money(item.amount)}</td></tr>`; }).join('')}</tbody><tfoot><tr><th colspan="3">Total de ${escape(label)}</th><th class="money">${money(total)}</th></tr></tfoot></table>`;
    }).join('')}`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Glosa e Ajuste</title><style>body{width:190mm;margin:0 auto;padding:9mm 9mm 18mm;font:9pt 'Times New Roman',serif;color:#000}.official{text-align:center;font:700 8pt Arial;line-height:1.2;margin-bottom:9px}.official img{display:block;width:24px;max-height:32px;object-fit:contain;margin:auto}.identity{font-weight:700;line-height:1.35}h2,h3{text-align:center}h2{font-size:12pt;margin:18px 0 8px}h3{font-size:10pt;margin:12px 0 4px}table{border-collapse:collapse;width:100%;margin:6px 0 12px}th,td{border:1px solid #000;padding:3px;vertical-align:top;text-align:left}th{text-align:center}.summary{table-layout:fixed}.summary th:nth-child(1),.summary td:nth-child(1){width:14.35%}.summary th:nth-child(2),.summary td:nth-child(2){width:14.35%}.summary th:nth-child(3),.summary td:nth-child(3){width:11.67%}.summary th:nth-child(4),.summary td:nth-child(4){width:14.91%}.summary th:nth-child(5),.summary td:nth-child(5){width:44.72%}.summary td{height:auto;min-height:76px;padding-bottom:6px}.observation{font-size:8pt;line-height:1.25;overflow-wrap:break-word}.money{text-align:right;white-space:nowrap}tfoot th{text-align:right}.report-footer{position:fixed;bottom:5mm;left:10mm;right:10mm;display:flex;gap:8px;align-items:center;font:8pt 'Times New Roman',serif}.report-footer .leader{flex:1;border-bottom:1px dotted #777}.report-pages{white-space:nowrap}.report-pages::after{content:counter(page) '/' counter(pages)}@media print{body{margin:0}@page{margin:11.09mm 9.42mm 14.94mm 10.81mm}}</style></head><body><div class="official"><img src="${reportLogo}" alt="Exército Brasileiro">MINISTÉRIO DA DEFESA<br>EXÉRCITO BRASILEIRO<br>CMDO 15ª BDA INF MEC</div><p class="identity">OCS: ${escape(data.ocs)}<br>PACIENTE: ${escape(data.patient)}<br>GUIA Nº: ${escape(data.number)}</p><table class="summary"><thead><tr><th>Valor<br>Apresentado</th><th>Glosa</th><th>Ajuste</th><th>Valor<br>Auditado</th><th>Observação</th></tr></thead><tbody><tr><td class="money">${money(data.billed)}</td><td class="money">${money(summary.glosa)}</td><td class="money">${money(summary.ajuste)}</td><td class="money">${money(summary.auditado)}</td><td class="observation">Com relação às glosas e possíveis recursos, favor cumprir rigorosamente os prazos e procedimentos previstos nas cláusulas 7.1.21 até a cláusula 7.1.31 do Termo de Contrato celebrado entre as partes.</td></tr></tbody></table>${sections}<p style="margin-top:26px">Quartel em Cascavel-PR, ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' })}</p><div style="display:flex;gap:20px;margin-top:38px;font:9pt Arial"><div style="width:45%;border-top:1px solid;text-align:center;padding-top:4px">Médico Auditor da Seção de Auditoria de Contas Médicas</div><div style="width:45%;border-top:1px solid;text-align:center;padding-top:4px">Enfermeira Auditora da Seção de Auditoria de Contas Médicas</div></div><footer class="report-footer"><span>(Relatório de Glosas do Atendimento ${escape(data.attendance_number || '________________')}</span><span class="leader"></span><span class="report-pages"></span><span>)</span></footer><script>window.addEventListener('load', () => window.print())</script></body></html>`;
}
async function save(data) {
  const status = data.status === 'FINALIZADA' ? 'FINALIZADA' : 'RASCUNHO';
  const ocs = String(data.ocs || '').trim(), patient = String(data.patient || '').trim(), attendanceNumber = String(data.attendanceNumber || '').trim(), billed = Number(data.billed || 0);
  const requestedNumber = String(data.number ?? '').trim();
  if (requestedNumber && !/^\d+$/.test(requestedNumber)) throw new Error('Número da guia inválido.');
  const requestedId = Number(requestedNumber || 0);
  if (!Number.isSafeInteger(requestedId)) throw new Error('Número da guia inválido.');
  if (status === 'FINALIZADA' && (!ocs || !patient)) throw new Error('Informe OCS e paciente.');
  if (!Number.isFinite(billed) || billed < 0) throw new Error('Valor apresentado inválido.');
  const items = (Array.isArray(data.items) ? data.items : []).map((item) => {
    const module = String(item.module || ''); const amount = Number(item.amount || 0);
    if (!validModule(module) || !Number.isFinite(amount) || amount < 0 || (status === 'FINALIZADA' && (!String(item.specification || '').trim() || !String(item.justification || '').trim()))) throw new Error('Preencha os campos obrigatórios de cada item.');
    return { module, specification: String(item.specification).trim(), specialty: isHonor(module) ? String(item.specialty || '').trim() : '', crm: isHonor(module) ? String(item.crm || '').trim() : '', justification: String(item.justification).trim(), amount: amount.toFixed(2) };
  });
  if (status === 'FINALIZADA' && !items.length) throw new Error('Inclua pelo menos um item.');
  const id = await transaction(async (connection) => {
    let id = requestedId;
    const existing = id ? await one('SELECT number, ocs, patient, billed, attendance_number, status, finalized_at FROM guides WHERE number=?', [id], connection) : null;
    if (id && !existing) throw new Error('Guia não encontrada.');
    if (existing && !guideAccess(existing).editable) throw new Error('Esta guia foi finalizada há mais de 30 dias e não pode mais ser editada.');
    const previousItems = existing ? await all('SELECT module, specification, specialty, crm, justification, amount FROM guide_items WHERE guide_number=? ORDER BY id', [id], connection) : [];
    const details = guideChanges(existing, previousItems, { ocs, patient, billed: billed.toFixed(2), attendance_number: attendanceNumber, status, items });
    if (id) await run(`UPDATE guides SET ocs=?, patient=?, billed=?, attendance_number=?, status=?, finalized_at=${status === 'FINALIZADA' ? 'COALESCE(finalized_at, CURRENT_TIMESTAMP)' : 'NULL'} WHERE number=?`, [ocs, patient, billed.toFixed(2), attendanceNumber, status, id], connection);
    else id = Number((await run(`INSERT INTO guides (ocs, patient, billed, attendance_number, status, finalized_at) VALUES (?, ?, ?, ?, ?, ${status === 'FINALIZADA' ? 'CURRENT_TIMESTAMP' : 'NULL'})`, [ocs, patient, billed.toFixed(2), attendanceNumber, status], connection)).lastInsertRowid);
    await run('DELETE FROM guide_items WHERE guide_number=?', [id], connection);
    for (const item of items) await run('INSERT INTO guide_items (guide_number, module, specification, specialty, crm, justification, amount) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, item.module, item.specification, item.specialty, item.crm, item.justification, item.amount], connection);
    const action = !existing ? (status === 'FINALIZADA' ? 'Guia criada e finalizada' : 'Guia criada') : status === 'FINALIZADA' && existing.status !== 'FINALIZADA' ? 'Guia finalizada' : details.length ? 'Guia editada' : 'Guia salva sem alterações';
    await run('INSERT INTO guide_edits (guide_number, username, action, details) VALUES (?, ?, ?, ?)', [id, data.username || 'Sistema', action, JSON.stringify(details)], connection);
    return id;
  });
  optionsVersion += 1;
  return guide(id);
}
function serve(response, file, type) { response.writeHead(200, { ...securityHeaders, 'Content-Type': type, 'Cache-Control': /^(font|image)\//.test(type) ? 'public, max-age=86400' : 'no-store', ...(type.includes('text/html') ? { 'Content-Security-Policy': "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'" } : {}) }); response.end(fs.readFileSync(file)); }

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost'); const pathname = url.pathname;
    if (pathname === '/styles.css') return serve(response, path.join(ROOT, 'public', 'styles.css'), 'text/css; charset=utf-8');
    if (pathname === '/bootstrap-icons.css') return serve(response, path.join(ROOT, 'node_modules', 'bootstrap-icons', 'font', 'bootstrap-icons.css'), 'text/css; charset=utf-8');
    if (pathname === '/fonts/bootstrap-icons.woff2') return serve(response, path.join(ROOT, 'node_modules', 'bootstrap-icons', 'font', 'fonts', 'bootstrap-icons.woff2'), 'font/woff2');
    if (pathname === '/fonts/bootstrap-icons.woff') return serve(response, path.join(ROOT, 'node_modules', 'bootstrap-icons', 'font', 'fonts', 'bootstrap-icons.woff'), 'font/woff');
    if (pathname === '/app.js') return serve(response, path.join(ROOT, 'public', 'app.js'), 'application/javascript; charset=utf-8');
    if (pathname === '/template-logo.png') return serve(response, path.join(ROOT, 'public', 'template-logo.png'), 'image/png');
    if (pathname === '/sisglosa.jpg') return serve(response, path.join(ROOT, 'public', 'sisglosa.jpg'), 'image/jpeg');
    if (['/', '/login', '/guias', '/registros', '/administracao', '/desenvolvedor', '/index.html'].includes(pathname)) return serve(response, path.join(ROOT, 'public', 'index.html'), 'text/html; charset=utf-8');
    if (pathname === '/health') { await one('SELECT 1'); return json(response, 200, { status: 'ok' }); }
    if (pathname === '/api/login' && request.method === 'POST') { const data = await body(request); const username = String(data.username || '').trim(); const key = loginKey(request, username); if (!loginAllowed(key)) return fail(response, 429, 'Muitas tentativas. Aguarde 15 minutos para tentar novamente.'); const saved = await one('SELECT username, password_hash, role, must_change_password FROM users WHERE username=?', [username]); if (!saved || !passwordMatches(String(data.password || ''), saved.password_hash)) { registerFailedLogin(key); return fail(response, 401, 'Usuário ou senha inválidos.'); } loginAttempts.delete(key); pruneSessions(); const id = crypto.randomUUID(); const session = { username: saved.username, role: saved.role, mustChangePassword: saved.must_change_password, expires: Date.now() + SESSION_TTL_MS }; sessions.set(id, session); return json(response, 200, sessionData(session), { 'Set-Cookie': sessionCookie(id) }); }
    if (pathname === '/api/logout' && request.method === 'POST') { sessions.delete(cookie(request, 'PMGU_SESSION')); return json(response, 200, {}, { 'Set-Cookie': sessionCookie('', 0) }); }
    const session = authenticated(request); if (!session) return fail(response, 401, 'Sessão expirada.');
    if (pathname === '/api/session') return json(response, 200, sessionData(session));
    if (pathname === '/api/password' && request.method === 'POST') { const data = await body(request); if (!strongPassword(data.password)) return fail(response, 400, 'A senha deve ter ao menos 8 caracteres, maiúscula, minúscula, número e símbolo.'); await run('UPDATE users SET password_hash=?, must_change_password=0 WHERE username=?', [hashPassword(data.password), session.username]); session.mustChangePassword = 0; return json(response, 200, sessionData(session)); }
    if (session.mustChangePassword) return fail(response, 403, 'Troque a senha temporária para continuar.');
    if (pathname === '/api/users' && request.method === 'GET') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); return json(response, 200, await all('SELECT id, username, role, must_change_password FROM users ORDER BY username')); }
    if (pathname === '/api/users' && request.method === 'POST') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); const data = await body(request); const username = String(data.username || '').trim(), role = String(data.role || 'user'); if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return fail(response, 400, 'Usuário: 3 a 40 caracteres (letras, números, ponto, hífen ou sublinhado).'); if (!['admin', 'user'].includes(role)) return fail(response, 400, 'Perfil inválido.'); const password = temporaryPassword(); try { await run('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)', [username, hashPassword(password), role]); return json(response, 201, { username, role, temporaryPassword: password }); } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ER_DUP_ENTRY') return fail(response, 409, 'Esse usuário já existe.'); console.error(error); return fail(response, 500, 'Não foi possível criar o usuário.'); } }
    const reset = pathname.match(/^\/api\/users\/(\d+)\/reset-password$/); if (reset && request.method === 'POST') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); const user = await one('SELECT username FROM users WHERE id=?', [Number(reset[1])]); if (!user) return fail(response, 404, 'Usuário não encontrado.'); const password = temporaryPassword(); await run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [hashPassword(password), Number(reset[1])]); clearUserSessions(user.username); return json(response, 200, { temporaryPassword: password }); }
    const removeUser = pathname.match(/^\/api\/users\/(\d+)$/); if (removeUser && request.method === 'DELETE') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); const user = await one('SELECT username, role FROM users WHERE id=?', [Number(removeUser[1])]); if (!user) return fail(response, 404, 'Usuário não encontrado.'); if (user.role === 'admin') return fail(response, 400, 'O administrador não pode ser removido.'); await run('DELETE FROM users WHERE id=?', [Number(removeUser[1])]); clearUserSessions(user.username); return json(response, 200, {}); }
    if (pathname === '/api/admin/system' && request.method === 'GET') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); return json(response, 200, await systemInfo()); }
    if (pathname === '/api/admin/updates' && request.method === 'GET') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); return json(response, 200, await updateHistory()); }
    if (pathname === '/api/admin/updates' && request.method === 'POST') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); if (!/^application\/(zip|octet-stream)(?:;|$)/.test(request.headers['content-type'] || '')) return fail(response, 415, 'Envie um arquivo ZIP.'); const filename = decodeURIComponent(String(request.headers['x-update-filename'] || 'atualizacao.zip')).replace(/[^A-Za-z0-9._-]/g, '_'); if (!filename.toLowerCase().endsWith('.zip')) return fail(response, 400, 'O pacote precisa ter extensão .zip.'); return json(response, 201, await applyUpdatePackage(await rawBody(request, MAX_UPDATE_SIZE), filename, session.username)); }
    if (session.role === 'admin') return fail(response, 403, 'Administradores não acessam as guias.');
    if (pathname === '/api/dashboard' && request.method === 'GET') return json(response, 200, await dashboard());
    if (pathname === '/api/guides' && request.method === 'GET') return json(response, 200, await listGuides(url.searchParams.get('status')));
    if (pathname === '/api/guides' && request.method === 'POST') return json(response, 201, await save({ ...(await body(request)), username: session.username }));
    if (pathname === '/api/options/ocs') return json(response, 200, (await all("SELECT DISTINCT ocs FROM guides WHERE trim(ocs)<>'' ORDER BY ocs")).map((row) => row.ocs));
    if (pathname === '/api/options/patients') return json(response, 200, (await all("SELECT DISTINCT patient FROM guides WHERE trim(patient)<>'' ORDER BY patient")).map((row) => row.patient));
    if (pathname === '/api/options/modules') return json(response, 200, [...new Set([...MODULES, ...(await all('SELECT DISTINCT module FROM guide_items WHERE module NOT IN (' + MODULES.map(() => '?').join(',') + ') ORDER BY module', MODULES)).map((row) => row.module)])]);
    if (pathname === '/api/options/specifications') return json(response, 200, (await all('SELECT DISTINCT specification FROM guide_items WHERE module=? ORDER BY specification', [url.searchParams.get('module') || ''])).map((row) => row.specification));
    if (pathname === '/api/options/justifications' && request.method === 'GET') return json(response, 200, await justificationOptions());
    if (pathname === '/api/options/justifications' && request.method === 'POST') { const value = String((await body(request)).justification || '').trim(); if (!value || value.length > 5000) return fail(response, 400, 'Justificativa inválida.'); const fingerprint = justificationFingerprint(value); await run('DELETE FROM deleted_justifications WHERE fingerprint=?', [fingerprint]); try { await run('INSERT INTO saved_justifications (fingerprint, justification) VALUES (?, ?)', [fingerprint, value]); } catch (error) { if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error.code !== 'ER_DUP_ENTRY') throw error; } optionsVersion += 1; return json(response, 201, { justification: value }); }
    if (pathname === '/api/options/justifications' && request.method === 'DELETE') { const value = String((await body(request)).justification || '').trim(); if (!value || value.length > 5000) return fail(response, 400, 'Justificativa inválida.'); if (value === DEFAULT_ADJUSTMENT_JUSTIFICATION) return fail(response, 400, 'A justificativa padrão de ajuste não pode ser excluída.'); const fingerprint = justificationFingerprint(value); await run('DELETE FROM saved_justifications WHERE fingerprint=?', [fingerprint]); try { await run('INSERT INTO deleted_justifications (fingerprint, justification) VALUES (?, ?)', [fingerprint, value]); } catch (error) { if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error.code !== 'ER_DUP_ENTRY') throw error; } optionsVersion += 1; return json(response, 200, {}); }
    const history = pathname.match(/^\/api\/guides\/(\d+)\/history$/); if (history && request.method === 'GET') return json(response, 200, (await all('SELECT username, action, details, created_at FROM guide_edits WHERE guide_number=? ORDER BY id DESC LIMIT 100', [Number(history[1])])).map((entry) => ({ ...entry, details: historyDetails(entry.details) })));
    const match = pathname.match(/^\/api\/guides\/(\d+)(\/report)?$/); if (match) { const data = await guide(Number(match[1])); if (!data) return fail(response, 404, 'Guia não encontrada.'); if (match[2]) { response.writeHead(200, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' }); return response.end(reportPage(data)); } if (request.method === 'GET') return json(response, 200, data); if (request.method === 'DELETE') { if (!data.editable) return fail(response, 403, 'Esta guia foi finalizada há mais de 30 dias e não pode mais ser excluída.'); await transaction(async (connection) => { await run('DELETE FROM guide_edits WHERE guide_number=?', [data.number], connection); await run('DELETE FROM guide_items WHERE guide_number=?', [data.number], connection); await run('DELETE FROM guides WHERE number=?', [data.number], connection); }); optionsVersion += 1; return json(response, 200, {}); } }
    return fail(response, 404, 'Rota não encontrada.');
  } catch (error) { console.error(error); return fail(response, error.statusCode || 400, error.statusCode ? error.message : (error.message || 'Não foi possível concluir a operação.')); }
});

async function start() {
  await initializeDatabase();
  const admin = await one('SELECT id FROM users WHERE username=?', ['admin']);
  if (admin) await run("UPDATE users SET role='admin' WHERE id=?", [admin.id]);
  else await run('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)', ['admin', hashPassword('Admin@123456'), 'admin']);
  server.listen(PORT, '127.0.0.1', () => console.log(`Guias PMGU moderno: http://localhost:${PORT}`));
}
start().catch((error) => { console.error('Não foi possível iniciar:', error.message); process.exitCode = 1; });
