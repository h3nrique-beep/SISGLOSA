const crypto = require('node:crypto');
const { all, run, insertIgnore } = require('./db');
const { httpError } = require('./http');
const { MODULES, DEFAULT_ADJUSTMENT_JUSTIFICATION } = require('./modules');

// Listas de sugestão da tela da guia: OCS, paciente, especificação, módulos e justificativas.
const fingerprint = (value) => crypto.createHash('sha256').update(String(value).trim()).digest('hex');
const SUGGESTION_KINDS = ['ocs', 'patients', 'specifications'];
// Sugestões removidas pelo usuário (x): continuam nas guias, só deixam de ser sugeridas.
const suggestionKey = (kind, value) => fingerprint(`${kind}\n${value}`);
async function visible(kind, values) {
  const hidden = new Set((await all('SELECT fingerprint FROM hidden_suggestions WHERE kind=?', [kind])).map((row) => row.fingerprint));
  return values.filter((value) => !hidden.has(suggestionKey(kind, value)));
}
const column = (rows, name) => rows.map((row) => row[name]);
// Sugestões tiradas das guias: só das guias do próprio usuário (owner = id do usuário logado).
const ownItems = 'guide_items i JOIN guides g ON g.number = i.guide_number AND g.owner_id = ?';
const ocs = async (owner) => visible('ocs', column(await all("SELECT DISTINCT ocs FROM guides WHERE owner_id=? AND trim(ocs)<>'' ORDER BY ocs", [owner]), 'ocs'));
const patients = async (owner) => visible('patients', column(await all("SELECT DISTINCT patient FROM guides WHERE owner_id=? AND trim(patient)<>'' ORDER BY patient", [owner]), 'patient'));
const specifications = async (owner, module) => visible('specifications', column(await all(`SELECT DISTINCT i.specification FROM ${ownItems} WHERE i.module=? AND trim(i.specification)<>'' ORDER BY i.specification`, [owner, module || '']), 'specification'));
async function modules(owner) {
  const custom = await all(`SELECT DISTINCT i.module FROM ${ownItems} WHERE i.module NOT IN (${MODULES.map(() => '?').join(',')}) ORDER BY i.module`, [owner, ...MODULES]);
  return [...new Set([...MODULES, ...column(custom, 'module')])];
}
async function hideSuggestion(kind, value) {
  value = String(value || '').trim();
  if (!SUGGESTION_KINDS.includes(kind) || !value || value.length > 5000) throw httpError(400, 'Sugestão inválida.');
  await insertIgnore('INSERT INTO hidden_suggestions (fingerprint, kind, suggestion) VALUES (?, ?, ?)', [suggestionKey(kind, value), kind, value]);
}

// A lista de justificativas varre todos os itens e bloqueava o servidor por centenas de ms: fica em memória até uma gravação a invalidar.
let version = 0;
const cache = new Map();
const invalidate = () => { version += 1; };
async function justifications(owner) {
  const current = version; const hit = cache.get(owner); if (hit?.version === current) return hit.value;
  const deleted = new Set(column(await all('SELECT fingerprint FROM deleted_justifications'), 'fingerprint'));
  const fromGuides = column(await all(`SELECT DISTINCT i.justification FROM ${ownItems} WHERE trim(i.justification)<>'' AND i.justification NOT LIKE 'Ajuste, será pago%' ORDER BY i.justification`, [owner]), 'justification').map((value) => value.trim());
  const manuallySaved = column(await all('SELECT justification FROM saved_justifications ORDER BY justification'), 'justification').map((value) => value.trim());
  const saved = [...new Set([...manuallySaved, ...fromGuides])].filter((value) => !deleted.has(fingerprint(value)));
  const value = [...new Set([DEFAULT_ADJUSTMENT_JUSTIFICATION, ...saved])];
  if (current === version) cache.set(owner, { version: current, value });
  return value;
}
const validJustification = (value) => { value = String(value || '').trim(); if (!value || value.length > 5000) throw httpError(400, 'Justificativa inválida.'); return value; };
async function saveJustification(value) {
  value = validJustification(value);
  await run('DELETE FROM deleted_justifications WHERE fingerprint=?', [fingerprint(value)]);
  await insertIgnore('INSERT INTO saved_justifications (fingerprint, justification) VALUES (?, ?)', [fingerprint(value), value]);
  invalidate();
  return { justification: value };
}
async function deleteJustification(value) {
  value = validJustification(value);
  if (value === DEFAULT_ADJUSTMENT_JUSTIFICATION) throw httpError(400, 'A justificativa padrão de ajuste não pode ser excluída.');
  await run('DELETE FROM saved_justifications WHERE fingerprint=?', [fingerprint(value)]);
  await insertIgnore('INSERT INTO deleted_justifications (fingerprint, justification) VALUES (?, ?)', [fingerprint(value), value]);
  invalidate();
}

module.exports = { ocs, patients, specifications, modules, hideSuggestion, justifications, saveJustification, deleteJustification, invalidate };
