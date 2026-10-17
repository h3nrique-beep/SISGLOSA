const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { mysql, databaseFile, sqliteSnapshot, replaceSqlite } = require('./db');
const { httpError } = require('./http');

// Backups do banco SQLite. A fonte da verdade é a pasta (cada .db com um .json ao lado), não uma tabela:
// restaurar um banco antigo apagaria da tabela os backups mais novos. Pelo mesmo motivo o histórico é um
// arquivo só de acréscimo, que sobrevive à restauração. No MySQL vale o deploy/proxmox/backup-sisglosa.sh.
const BACKUP_ROOT = process.env.BACKUP_ROOT || path.join(path.dirname(databaseFile), 'backups');
const HISTORY_FILE = path.join(BACKUP_ROOT, 'historico.jsonl');
const NAME_PATTERN = /^guias-\d{8}-\d{9}-(manual|auto|pre-update|pre-restore)\.db$/;
const KINDS = ['manual', 'auto', 'pre-update', 'pre-restore'];
const AUTO_EVERY_MS = 24 * 60 * 60 * 1000;
const AUTO_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const OTHERS_KEEP = 20;
const ENCRYPTED_MAGIC = Buffer.from('SGBK1');

const ensureEnabled = () => { if (mysql) throw httpError(400, 'Com MySQL/MariaDB, o backup é feito pelo script deploy/proxmox/backup-sisglosa.sh.'); };
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pad = (value, size = 2) => String(value).padStart(size, '0');
function stamp(date = new Date()) { return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`; }

// Abre a cópia só para leitura: confere a integridade e conta guias e usuários.
function inspect(file) {
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = copy.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]).join('; ');
    const count = (table) => { try { return Number(copy.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total); } catch { return null; } };
    return { ok: integrity === 'ok', integrity, guides: count('guides'), users: count('users') };
  } finally { copy.close(); }
}

function log(action, username, detail = {}) {
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify({ at: Date.now(), action, username, ...detail })}\n`);
}
function history(limit = 20) {
  try { return fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

function list() {
  if (mysql) return [];
  let names = [];
  try { names = fs.readdirSync(BACKUP_ROOT).filter((name) => NAME_PATTERN.test(name)); } catch { return []; }
  return names.map((name) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(BACKUP_ROOT, `${name}.json`), 'utf8')); } catch {}
    return { name, kind: name.match(NAME_PATTERN)[1], size: fs.statSync(path.join(BACKUP_ROOT, name)).size, ...meta };
  }).sort((a, b) => b.name.localeCompare(a.name));
}

// O nome vem do navegador: só vale se for um backup que existe na pasta (nunca vira caminho cru).
function backupFile(name) {
  if (!NAME_PATTERN.test(String(name || '')) || !list().some((backup) => backup.name === name)) throw httpError(404, 'Backup não encontrado.');
  return path.join(BACKUP_ROOT, name);
}

function prune() {
  const now = Date.now();
  const all = list(), others = all.filter((backup) => backup.kind !== 'auto');
  const expired = [...all.filter((backup) => backup.kind === 'auto' && now - (backup.created_at || 0) > AUTO_KEEP_MS), ...others.slice(OTHERS_KEEP)];
  for (const backup of expired) for (const file of [backup.name, `${backup.name}.json`]) fs.rmSync(path.join(BACKUP_ROOT, file), { force: true });
}

function create(kind, username = 'Sistema') {
  ensureEnabled();
  if (!KINDS.includes(kind)) throw httpError(400, 'Tipo de backup inválido.');
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  const name = `guias-${stamp()}-${kind}.db`, file = path.join(BACKUP_ROOT, name);
  sqliteSnapshot(file);
  try { fs.chmodSync(file, 0o600); } catch {}
  const meta = { created_at: Date.now(), created_by: username, sha256: sha256(file), ...inspect(file) };
  fs.writeFileSync(path.join(BACKUP_ROOT, `${name}.json`), JSON.stringify(meta));
  log('criado', username, { name, ok: meta.ok });
  prune();
  return { name, kind, size: fs.statSync(file).size, ...meta };
}

// Arquivo baixado sai cifrado (AES-256-GCM, chave derivada da frase-senha): o banco tem dados de pacientes e hashes de senha.
function encrypt(buffer, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([ENCRYPTED_MAGIC, salt, iv, cipher.getAuthTag(), body]);
}
function decrypt(buffer, passphrase) {
  if (!buffer.subarray(0, 5).equals(ENCRYPTED_MAGIC)) throw new Error('Arquivo não é um backup cifrado do SISGLOSA.');
  const salt = buffer.subarray(5, 21), iv = buffer.subarray(21, 33), tag = buffer.subarray(33, 49);
  const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.scryptSync(passphrase, salt, 32), iv);
  decipher.setAuthTag(tag);
  try { return Buffer.concat([decipher.update(buffer.subarray(49)), decipher.final()]); } catch { throw new Error('Frase-senha incorreta ou arquivo corrompido.'); }
}

// shortcut: lê o banco inteiro na memória; serve enquanto o banco tiver poucos MB, trocar por stream se passar disso.
function download(name, passphrase, username, ip) {
  ensureEnabled();
  if (String(passphrase || '').length < 8) throw httpError(400, 'A frase-senha do arquivo precisa ter ao menos 8 caracteres.');
  const file = backupFile(name);
  log('baixado', username, { name, ip });
  return encrypt(fs.readFileSync(file), String(passphrase));
}

// Antes de trocar o banco: confere o backup escolhido e guarda o banco atual (pre-restore) para poder voltar.
async function restore(name, username, ip, appVersion) {
  ensureEnabled();
  const file = backupFile(name), meta = list().find((backup) => backup.name === name);
  if (meta.sha256 && sha256(file) !== meta.sha256) throw httpError(400, 'O arquivo do backup foi alterado desde que foi gerado; restauração recusada.');
  if (!inspect(file).ok) throw httpError(400, 'O backup não passou na verificação de integridade; restauração recusada.');
  const safety = create('pre-restore', username);
  try { await replaceSqlite(file, appVersion); } catch (error) {
    await replaceSqlite(path.join(BACKUP_ROOT, safety.name), appVersion);
    throw httpError(500, `Não foi possível restaurar (${error.message}); o banco anterior foi mantido.`);
  }
  log('restaurado', username, { name, ip, safety: safety.name });
  return { restored: name, safety: safety.name };
}

// Backup automático: na inicialização e a cada hora confere se o último automático tem mais de 24 h.
function runSchedule() {
  if (mysql) return;
  const last = list().find((backup) => backup.kind === 'auto');
  if (last && Date.now() - (last.created_at || 0) < AUTO_EVERY_MS) return;
  try { create('auto'); } catch (error) { console.error('Backup automático falhou:', error.message); }
}
function startSchedule() { runSchedule(); setInterval(runSchedule, 60 * 60 * 1000).unref(); }

module.exports = { BACKUP_ROOT, list, history, create, download, restore, decrypt, startSchedule, enabled: () => !mysql };
