const fs = require('node:fs');
const path = require('node:path');
const { databaseFile } = require('./db');

// Registro de ações (quem, o quê, de qual IP, quando). Arquivo só de acréscimo ao lado do banco,
// como o histórico de backups: restaurar um banco antigo não apaga o registro.
const AUDIT_FILE = process.env.AUDIT_FILE || path.join(path.dirname(databaseFile), 'auditoria.jsonl');

function record(action, username, ip, detail = {}) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ at: Date.now(), action, username: String(username || '').slice(0, 60), ip: ip || '', ...detail })}\n`);
  } catch (error) { console.error('Não foi possível gravar o registro de ações:', error.message); }
}
const entries = () => { try { return fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; } };
// A tela mostra um dia por vez. since/until e o fuso vêm do navegador (o servidor pode estar em UTC).
function list(since = 0, until = Infinity, limit = 2000) { return entries().filter((entry) => Number(entry.at || 0) >= since && Number(entry.at || 0) < until).slice(-limit).reverse(); }
// Dias (AAAA-MM-DD, no fuso de quem consulta) em que houve alguma ação, do mais novo para o mais antigo.
function days(offsetMinutes = 0) { return [...new Set(entries().map((entry) => new Date(Number(entry.at || 0) - offsetMinutes * 60000).toISOString().slice(0, 10)))].sort().reverse(); }

// Retenção: registros com mais de AUDIT_KEEP_DAYS (padrão 365) saem na inicialização e uma vez por dia.
// Reescreve num arquivo temporário e troca, para uma queda no meio não deixar o registro pela metade.
const KEEP_MS = Number(process.env.AUDIT_KEEP_DAYS || 365) * 24 * 60 * 60 * 1000;
function prune(now = Date.now()) {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return 0;
    const all = entries(), kept = all.filter((entry) => now - Number(entry.at || 0) <= KEEP_MS);
    if (kept.length === all.length) return 0;
    fs.writeFileSync(`${AUDIT_FILE}.tmp`, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    fs.renameSync(`${AUDIT_FILE}.tmp`, AUDIT_FILE);
    return all.length - kept.length;
  } catch (error) { console.error('Não foi possível limpar o registro de ações:', error.message); return 0; }
}
function startPrune() { prune(); setInterval(prune, 24 * 60 * 60 * 1000).unref(); }

module.exports = { AUDIT_FILE, record, list, days, prune, startPrune };
