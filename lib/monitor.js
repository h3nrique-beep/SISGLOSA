const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mysql, databaseFile, all, one, run } = require('./db');
const backups = require('./backups');

// Monitor de saúde (versão enxuta do monitor do Sentinela): um alerta por problema (chave), que atualiza em vez
// de duplicar e fecha sozinho quando a condição some. Limites fixos: com 2 usuários não há volume para um
// "normal" estatístico por hora. Tudo roda dentro do próprio processo (o Node fica sempre ligado; sem cron).
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.dirname(databaseFile);
const SNAPSHOT_FILE = path.join(DATA_DIR, 'monitor', 'integridade.json');
const WATCHED_FILES = ['server.js', 'package.json', 'package-lock.json'];
const WATCHED_FOLDERS = ['lib', 'public', 'scripts'];
const SEVERITY_ORDER = { CRITICO: 0, ALTO: 1, MEDIO: 2, INFO: 3 };
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE;
const BACKUP_LATE_MS = 26 * HOUR;
const LOGIN_WINDOW_MS = 10 * MINUTE, LOGIN_BURST = 20;
let lastCheckAt = null;

async function raise(key, severity, title, detail = '') {
  const now = Date.now();
  const existing = await one('SELECT resolved_at FROM monitor_alerts WHERE alert_key=?', [key]);
  if (!existing) await run('INSERT INTO monitor_alerts (alert_key, severity, title, detail, opened_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)', [key, severity, title, detail, now, now]);
  else if (existing.resolved_at !== null) await run('UPDATE monitor_alerts SET severity=?, title=?, detail=?, seen_at=?, opened_at=?, resolved_at=NULL WHERE alert_key=?', [severity, title, detail, now, now, key]);
  else await run('UPDATE monitor_alerts SET severity=?, title=?, detail=?, seen_at=? WHERE alert_key=?', [severity, title, detail, now, key]);
  return key;
}
// Fecha os alertas abertos do grupo (prefixo) que não estão mais acontecendo.
async function closeAbsent(prefix, activeKeys) {
  const open = await all('SELECT alert_key FROM monitor_alerts WHERE resolved_at IS NULL AND alert_key LIKE ?', [`${prefix}%`]);
  for (const { alert_key: key } of open) if (!activeKeys.includes(key)) await run('UPDATE monitor_alerts SET resolved_at=? WHERE alert_key=?', [Date.now(), key]);
}

// Requisições e falhas de login: contadores em memória por minuto (somem num reinício, e tudo bem).
const requestMinutes = new Map(), loginFailures = [];
function request(status) {
  const minute = Math.floor(Date.now() / MINUTE), bucket = requestMinutes.get(minute) || { total: 0, errors: 0 };
  bucket.total += 1; if (status >= 500) bucket.errors += 1; requestMinutes.set(minute, bucket);
}
function loginFailed(ip) { loginFailures.push({ at: Date.now(), ip: String(ip || 'desconhecido') }); }

async function checkTraffic() {
  const now = Date.now(), active = [];
  for (const minute of requestMinutes.keys()) if (minute < Math.floor((now - HOUR) / MINUTE)) requestMinutes.delete(minute);
  const hour = [...requestMinutes.values()].reduce((sum, bucket) => ({ total: sum.total + bucket.total, errors: sum.errors + bucket.errors }), { total: 0, errors: 0 });
  if (hour.total >= 50 && hour.errors / hour.total > 0.02) active.push(await raise('req.erros', 'ALTO', 'Erros do servidor acima de 2%', `${hour.errors} de ${hour.total} requisições com erro 5xx na última hora. Veja o log do serviço (journalctl -u sisglosa).`));
  await closeAbsent('req.', active);

  while (loginFailures.length && loginFailures[0].at < now - LOGIN_WINDOW_MS) loginFailures.shift();
  const loginActive = [];
  if (loginFailures.length >= LOGIN_BURST) {
    const byIp = {}; for (const { ip } of loginFailures) byIp[ip] = (byIp[ip] || 0) + 1;
    const top = Object.entries(byIp).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([ip, count]) => `${ip} (${count})`).join(', ');
    loginActive.push(await raise('login.rajada', 'ALTO', 'Muitas falhas de login', `${loginFailures.length} tentativas com senha errada nos últimos 10 minutos. Origem: ${top}.`));
  }
  await closeAbsent('login.', loginActive);
}

async function sample() {
  const now = Date.now();
  const ram = Math.round(1000 * (1 - os.freemem() / os.totalmem())) / 10;
  let disk = null;
  try { const stats = await fs.promises.statfs(DATA_DIR); disk = Math.round(1000 * stats.bavail / stats.blocks) / 10; } catch {}
  let dbKb = null;
  if (!mysql) dbKb = Math.round(['', '-wal'].reduce((total, suffix) => { try { return total + fs.statSync(databaseFile + suffix).size; } catch { return total; } }, 0) / 1024);
  await run('INSERT INTO monitor_samples (taken_at, ram_pct, disk_free_pct, db_kb) VALUES (?, ?, ?, ?)', [now, ram, disk, dbKb]);
  await run('DELETE FROM monitor_samples WHERE taken_at < ?', [now - 48 * HOUR]);

  const active = [];
  if (disk !== null && disk < 10) active.push(await raise('recurso.disco', disk < 5 ? 'CRITICO' : 'ALTO', 'Pouco espaço em disco', `${disk.toLocaleString('pt-BR')}% livre na partição do banco. Sem espaço, o banco e os backups param de gravar.`));
  const recent = await all('SELECT ram_pct FROM monitor_samples WHERE taken_at >= ? AND ram_pct IS NOT NULL', [now - 30 * MINUTE]);
  if (recent.length >= 25 && recent.every((row) => Number(row.ram_pct) > 90)) active.push(await raise('recurso.ram', 'ALTO', 'RAM acima de 90% há 30 minutos', `Uso atual: ${ram.toLocaleString('pt-BR')}%. Verifique outros processos no servidor.`));
  await closeAbsent('recurso.', active);
  await checkTraffic();
}

// Integridade do código: hash de cada arquivo. Mudança fora de um pacote aplicado pelo painel é alerta CRÍTICO.
function walk(folder) {
  const absolute = path.join(ROOT, folder);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = `${folder}/${entry.name}`;
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}
function fileHashes() {
  const files = [...WATCHED_FILES.filter((file) => fs.existsSync(path.join(ROOT, file))), ...WATCHED_FOLDERS.flatMap(walk)].sort();
  return Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')]));
}
function readSnapshot() { try { return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')); } catch { return null; } }
function snapshotFiles(username = 'Sistema') {
  fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
  const snapshot = { created_at: Date.now(), created_by: username, files: fileHashes() };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot));
  return snapshot;
}
function compareFiles() {
  const snapshot = readSnapshot() || snapshotFiles();
  const now = fileHashes(), before = snapshot.files || {};
  return {
    snapshot_at: snapshot.created_at, snapshot_by: snapshot.created_by,
    changed: Object.keys(now).filter((file) => file in before && before[file] !== now[file]),
    added: Object.keys(now).filter((file) => !(file in before)),
    removed: Object.keys(before).filter((file) => !(file in now)),
  };
}
async function acceptFiles(username) { snapshotFiles(username); await closeAbsent('arquivos.', []); }

async function checkIntegrity() {
  const files = compareFiles(), fileAlerts = [];
  const listed = (label, items) => items.length ? `${label}: ${items.slice(0, 8).join(', ')}${items.length > 8 ? ` e mais ${items.length - 8}` : ''}.` : '';
  if (files.changed.length + files.added.length + files.removed.length) {
    fileAlerts.push(await raise('arquivos.alterados', 'CRITICO', 'Código alterado fora de uma atualização', [listed('Alterados', files.changed), listed('Novos', files.added), listed('Removidos', files.removed), 'Se a mudança foi sua, use "Aceitar estado atual".'].filter(Boolean).join(' ')));
  }
  await closeAbsent('arquivos.', fileAlerts);

  const dbAlerts = [];
  if (!mysql) {
    const result = (await all('PRAGMA quick_check')).map((row) => Object.values(row)[0]).join('; ');
    if (result !== 'ok') dbAlerts.push(await raise('banco.integridade', 'CRITICO', 'Banco de dados com erro de integridade', `PRAGMA quick_check: ${result.slice(0, 400)}. Restaure o último backup íntegro.`));
  }
  await closeAbsent('banco.', dbAlerts);

  const backupAlerts = [];
  if (backups.enabled()) {
    const [latest] = backups.list();
    if (!latest || Date.now() - (latest.created_at || 0) > BACKUP_LATE_MS) backupAlerts.push(await raise('backup.atrasado', 'ALTO', 'Backup atrasado', latest ? `O último backup é de ${new Date(latest.created_at).toLocaleString('pt-BR')}. O automático deveria rodar a cada 24 h.` : 'Nenhum backup encontrado.'));
    if (latest && latest.ok === false) backupAlerts.push(await raise('backup.falha', 'ALTO', 'Último backup não passou na verificação', `${latest.name}: ${latest.integrity || 'sem detalhes'}.`));
  }
  await closeAbsent('backup.', backupAlerts);
  lastCheckAt = Date.now();
}

async function status() {
  const open = (await all('SELECT alert_key, severity, title, detail, opened_at, seen_at FROM monitor_alerts WHERE resolved_at IS NULL')).sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || Number(a.opened_at) - Number(b.opened_at));
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const resolved = await all('SELECT alert_key, severity, title, opened_at, resolved_at FROM monitor_alerts WHERE resolved_at >= ? ORDER BY resolved_at DESC', [midnight.getTime()]);
  const samples = (await all('SELECT taken_at, ram_pct, disk_free_pct, db_kb FROM monitor_samples ORDER BY taken_at')).map((row) => ({ at: Number(row.taken_at), ram: row.ram_pct === null ? null : Number(row.ram_pct), disk: row.disk_free_pct === null ? null : Number(row.disk_free_pct), dbKb: row.db_kb === null ? null : Number(row.db_kb) }));
  const health = open.some((alert) => alert.severity === 'CRITICO') ? 'vermelho' : open.some((alert) => alert.severity !== 'INFO') ? 'amarelo' : 'verde';
  const snapshot = readSnapshot();
  // Gráfico: até ~300 pontos (48 h a cada ~10 min) bastam.
  const step = Math.max(1, Math.ceil(samples.length / 300));
  return { health, open, resolved, samples: samples.filter((_, index) => index % step === 0 || index === samples.length - 1), latest: samples.at(-1) || null, checkedAt: lastCheckAt, snapshotAt: snapshot?.created_at || null, snapshotBy: snapshot?.created_by || null };
}

const safely = (work, label) => () => work().catch((error) => console.error(`Monitor (${label}):`, error.message));
function start() {
  const minute = safely(sample, 'recursos'), hourly = safely(checkIntegrity, 'integridade');
  minute(); hourly();
  setInterval(minute, MINUTE).unref();
  setInterval(hourly, HOUR).unref();
}

module.exports = { start, status, checkIntegrity, acceptFiles, snapshotFiles, request, loginFailed };
