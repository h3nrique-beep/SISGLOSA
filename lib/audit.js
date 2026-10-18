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
// shortcut: lê o arquivo inteiro a cada consulta; com 2 usuários cresce pouco. Rotacionar se passar de alguns MB.
function list(limit = 300) {
  try { return fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); } catch { return []; }
}

module.exports = { AUDIT_FILE, record, list };
