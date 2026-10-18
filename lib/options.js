const crypto = require('node:crypto');
const { all, run, insertIgnore } = require('./db');
const { httpError } = require('./http');
const { MODULES, DEFAULT_ADJUSTMENT_JUSTIFICATION } = require('./modules');

// Listas de sugestão da tela da guia: OCS, paciente, especificação, módulos e justificativas.
const fingerprint = (value) => crypto.createHash('sha256').update(String(value).trim()).digest('hex');
const SUGGESTION_KINDS = ['ocs', 'patients', 'specifications'];
// Sugestões removidas pelo usuário (x): continuam nas guias, só deixam de ser sugeridas para ele.
// Cada usuário tem as suas; o fingerprint leva o dono para a chave única não juntar usuários diferentes.
// Registros antigos (owner_id NULL) continuam valendo para todos.
const mine = '(owner_id=? OR owner_id IS NULL)';
const ownedKey = (owner, ...parts) => fingerprint([owner, ...parts].join('\n'));
async function visible(owner, kind, values) {
  const hidden = new Set(column(await all(`SELECT suggestion FROM hidden_suggestions WHERE kind=? AND ${mine}`, [kind, owner]), 'suggestion').map((value) => value.trim()));
  return values.filter((value) => !hidden.has(String(value).trim()));
}
const column = (rows, name) => rows.map((row) => row[name]);
// Sugestões tiradas das guias: só das guias do próprio usuário (owner = id do usuário logado).
const ownItems = 'guide_items i JOIN guides g ON g.number = i.guide_number AND g.owner_id = ?';
const ocs = async (owner) => visible(owner, 'ocs', column(await all("SELECT DISTINCT ocs FROM guides WHERE owner_id=? AND trim(ocs)<>'' ORDER BY ocs", [owner]), 'ocs'));
const patients = async (owner) => visible(owner, 'patients', column(await all("SELECT DISTINCT patient FROM guides WHERE owner_id=? AND trim(patient)<>'' ORDER BY patient", [owner]), 'patient'));
const specifications = async (owner, module) => visible(owner, 'specifications', column(await all(`SELECT DISTINCT i.specification FROM ${ownItems} WHERE i.module=? AND trim(i.specification)<>'' ORDER BY i.specification`, [owner, module || '']), 'specification'));
async function modules(owner) {
  const custom = await all(`SELECT DISTINCT i.module FROM ${ownItems} WHERE i.module NOT IN (${MODULES.map(() => '?').join(',')}) ORDER BY i.module`, [owner, ...MODULES]);
  return [...new Set([...MODULES, ...column(custom, 'module')])];
}
async function hideSuggestion(owner, kind, value) {
  value = String(value || '').trim();
  if (!SUGGESTION_KINDS.includes(kind) || !value || value.length > 5000) throw httpError(400, 'Sugestão inválida.');
  await insertIgnore('INSERT INTO hidden_suggestions (fingerprint, kind, suggestion, owner_id) VALUES (?, ?, ?, ?)', [ownedKey(owner, kind, value), kind, value, owner]);
}

// A lista de justificativas varre todos os itens e bloqueava o servidor por centenas de ms: fica em memória até uma gravação a invalidar.
let version = 0;
const cache = new Map();
const invalidate = () => { version += 1; };
async function justifications(owner) {
  const current = version; const hit = cache.get(owner); if (hit?.version === current) return hit.value;
  const deleted = new Set(column(await all(`SELECT justification FROM deleted_justifications WHERE ${mine}`, [owner]), 'justification').map((value) => value.trim()));
  const fromGuides = column(await all(`SELECT DISTINCT i.justification FROM ${ownItems} WHERE trim(i.justification)<>'' AND i.justification NOT LIKE 'Ajuste, será pago%' ORDER BY i.justification`, [owner]), 'justification').map((value) => value.trim());
  const manuallySaved = column(await all(`SELECT justification FROM saved_justifications WHERE ${mine} ORDER BY justification`, [owner]), 'justification').map((value) => value.trim());
  const saved = [...new Set([...manuallySaved, ...fromGuides])].filter((value) => !deleted.has(value));
  const value = [...new Set([DEFAULT_ADJUSTMENT_JUSTIFICATION, ...saved])];
  if (current === version) cache.set(owner, { version: current, value });
  return value;
}
const validJustification = (value) => { value = String(value || '').trim(); if (!value || value.length > 5000) throw httpError(400, 'Justificativa inválida.'); return value; };
async function saveJustification(owner, value) {
  value = validJustification(value);
  await run(`DELETE FROM deleted_justifications WHERE justification=? AND ${mine}`, [value, owner]);
  await insertIgnore('INSERT INTO saved_justifications (fingerprint, justification, owner_id) VALUES (?, ?, ?)', [ownedKey(owner, value), value, owner]);
  invalidate();
  return { justification: value };
}
async function deleteJustification(owner, value) {
  value = validJustification(value);
  if (value === DEFAULT_ADJUSTMENT_JUSTIFICATION) throw httpError(400, 'A justificativa padrão de ajuste não pode ser excluída.');
  await run('DELETE FROM saved_justifications WHERE justification=? AND owner_id=?', [value, owner]);
  await insertIgnore('INSERT INTO deleted_justifications (fingerprint, justification, owner_id) VALUES (?, ?, ?)', [ownedKey(owner, value), value, owner]);
  invalidate();
}

module.exports = { ocs, patients, specifications, modules, hideSuggestion, justifications, saveJustification, deleteJustification, invalidate };
