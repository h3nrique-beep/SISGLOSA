const { all, one, run, transaction, mysql } = require('./db');
const { httpError, money } = require('./http');
const { isHonor, hasSector, validModule, totals, sumKind } = require('./modules');
const options = require('./options');

const FINALIZED_EDIT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function finalizedDate(value) {
  if (!value) return null; if (value instanceof Date) return value;
  const text = String(value);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
}
// Guia finalizada continua editável por 30 dias; depois, só consulta e impressão.
function guideAccess(data) {
  const finalized = finalizedDate(data.finalized_at);
  const editableUntil = finalized ? new Date(finalized.getTime() + FINALIZED_EDIT_WINDOW_MS) : null;
  return { editable: data.status !== 'FINALIZADA' || !editableUntil || Date.now() <= editableUntil.getTime(), editable_until: editableUntil?.toISOString() || null };
}

// owner: id do usuário logado; guia de outro usuário responde como inexistente.
async function guide(id, owner) {
  const data = await one('SELECT number, guide_code, ocs, patient, billed, attendance_number, status, finalized_at FROM guides WHERE number=? AND owner_id=?', [id, owner]);
  if (!data) return null;
  data.items = (await all('SELECT module, specification, specialty, crm, sector, justification, amount FROM guide_items WHERE guide_number=? ORDER BY id', [id])).map((item) => ({ ...item, amount: Number(item.amount) }));
  data.billed = Number(data.billed);
  return { ...data, ...guideAccess(data) };
}

// Filtros da tela Registros. Período pela data da finalização (ou da criação, no rascunho).
// shortcut: compara a data em UTC; uma guia salva entre 21h e 0h (Brasília) cai no dia seguinte. Trocar se isso confundir os filtros.
const guideDate = 'DATE(COALESCE(g.finalized_at, g.created_at))';
function guideFilters(owner, query = {}) {
  const where = ['g.owner_id=?'], params = [owner];
  const get = (name) => String(query[name] || '').trim();
  if (['RASCUNHO', 'FINALIZADA'].includes(get('status'))) { where.push('g.status=?'); params.push(get('status')); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(get('from'))) { where.push(`${guideDate} >= ?`); params.push(get('from')); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(get('to'))) { where.push(`${guideDate} <= ?`); params.push(get('to')); }
  for (const [name, columnName] of [['ocs', 'g.ocs'], ['patient', 'g.patient'], ['attendance', 'g.attendance_number']]) {
    if (get(name)) { where.push(`LOWER(${columnName}) LIKE ?`); params.push(`%${get(name).toLowerCase()}%`); }
  }
  // shortcut: no SQLite, LOWER/LIKE só ignoram maiúsculas sem acento ("josé" não acha "JOSÉ"); trocar por coluna normalizada se incomodar.
  if (get('q')) { where.push('(LOWER(g.ocs) LIKE ? OR LOWER(g.patient) LIKE ? OR LOWER(g.attendance_number) LIKE ? OR LOWER(g.guide_code) LIKE ?)'); params.push(...Array(4).fill(`%${get('q').toLowerCase()}%`)); }
  return { sql: ` WHERE ${where.join(' AND ')}`, params };
}
const kindSum = (prefix) => `COALESCE(SUM(CASE WHEN i.module LIKE '${prefix}%' THEN i.amount ELSE 0 END), 0)`;
async function listGuides(owner, query = {}, limit = 500) {
  const filter = guideFilters(owner, query);
  // Escolhe as guias primeiro (LIMIT) e só depois soma os itens delas: somar antes varria todos os itens do usuário.
  const rows = await all(`SELECT g.number, g.guide_code, g.ocs, g.patient, g.billed, g.attendance_number, g.status, g.finalized_at, g.created_at, ${kindSum('Glosa')} AS glosa, ${kindSum('Ajuste')} AS ajuste FROM (SELECT g.* FROM guides g${filter.sql} ORDER BY g.number DESC LIMIT ${Number(limit)}) g LEFT JOIN guide_items i ON i.guide_number = g.number GROUP BY g.number, g.guide_code, g.ocs, g.patient, g.billed, g.attendance_number, g.status, g.finalized_at, g.created_at ORDER BY g.number DESC`, filter.params);
  return rows.map((row) => ({ ...row, billed: Number(row.billed), glosa: Number(row.glosa), ajuste: Number(row.ajuste), ...guideAccess(row) }));
}

async function dashboard(owner) {
  const counts = await one("SELECT COUNT(*) AS total, SUM(CASE WHEN status='RASCUNHO' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status='FINALIZADA' THEN 1 ELSE 0 END) AS finalized FROM guides WHERE owner_id=?", [owner]);
  const open = await listGuides(owner, { status: 'RASCUNHO' }, 100000);
  return {
    total: Number(counts.total || 0), open: Number(counts.open || 0), finalized: Number(counts.finalized || 0),
    billed: open.reduce((sum, row) => sum + row.billed, 0), glosa: open.reduce((sum, row) => sum + row.glosa, 0), ajuste: open.reduce((sum, row) => sum + row.ajuste, 0),
    recent: (await listGuides(owner, {}, 5)),
  };
}

// Outras guias com o mesmo nº de atendimento (aviso de possível duplicidade).
async function sameAttendance(attendance, exclude, owner) {
  attendance = String(attendance || '').trim();
  if (!attendance) return [];
  return all('SELECT number, ocs, patient, status FROM guides WHERE attendance_number=? AND number<>? AND owner_id=? ORDER BY number DESC LIMIT 10', [attendance, Number(exclude) || 0, owner]);
}

function historyText(value) { return String(value ?? '').trim() || 'não informado'; }
function historyStatus(value) { return value === 'FINALIZADA' ? 'Finalizada' : 'Rascunho'; }
function historyItem(item) { return [item.module, item.specification].filter(Boolean).join(' — ') || 'sem identificação'; }
function detailChange(details, label, before, after, format = historyText) { if (String(before ?? '').trim() !== String(after ?? '').trim()) details.push(`${label}: ${format(before)} → ${format(after)}`); }
function guideChanges(previous, previousItems, next) {
  const details = [];
  if (!previous) {
    if (next.guide_code) details.push(`Nº da guia definido como ${historyText(next.guide_code)}`);
    if (next.ocs) details.push(`OCS definido como ${historyText(next.ocs)}`);
    if (next.patient) details.push(`Paciente definido como ${historyText(next.patient)}`);
    if (next.attendance_number) details.push(`Nº do atendimento definido como ${historyText(next.attendance_number)}`);
    if (Number(next.billed)) details.push(`Valor apresentado definido como ${money(next.billed)}`);
  } else {
    detailChange(details, 'Nº da guia', previous.guide_code, next.guide_code);
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
    detailChange(itemDetails, 'Setor', before.sector, after.sector);
    detailChange(itemDetails, 'Justificativa', before.justification, after.justification);
    detailChange(itemDetails, 'Valor', before.amount, after.amount, (value) => money(value));
    if (itemDetails.length) details.push(`Item ${index + 1} (${historyItem(after)}): ${itemDetails.join('; ')}`);
  }
  return details;
}
function historyDetails(value) { try { const details = JSON.parse(value || '[]'); return Array.isArray(details) ? details : []; } catch { return []; } }
async function history(id, owner) {
  if (!await one('SELECT number FROM guides WHERE number=? AND owner_id=?', [id, owner])) throw httpError(404, 'Guia não encontrada.');
  return (await all('SELECT username, action, details, created_at FROM guide_edits WHERE guide_number=? ORDER BY id DESC LIMIT 100', [id])).map((entry) => ({ ...entry, details: historyDetails(entry.details) }));
}

async function save(data) {
  const status = data.status === 'FINALIZADA' ? 'FINALIZADA' : 'RASCUNHO';
  const guideCode = String(data.guideCode || '').trim();
  if (guideCode.length > 50) throw httpError(400, 'Nº da guia: até 50 caracteres.');
  const ocs = String(data.ocs || '').trim(), patient = String(data.patient || '').trim(), attendanceNumber = String(data.attendanceNumber || '').trim(), billed = Number(data.billed || 0);
  const requestedNumber = String(data.number ?? '').trim();
  if (requestedNumber && !/^\d+$/.test(requestedNumber)) throw httpError(400, 'Número da guia inválido.');
  const requestedId = Number(requestedNumber || 0);
  if (!Number.isSafeInteger(requestedId)) throw httpError(400, 'Número da guia inválido.');
  if (status === 'FINALIZADA' && (!ocs || !patient)) throw httpError(400, 'Informe OCS e paciente.');
  if (!Number.isFinite(billed) || billed < 0) throw httpError(400, 'Valor apresentado inválido.');
  const items = (Array.isArray(data.items) ? data.items : []).map((item) => {
    const module = String(item.module || ''); const amount = Number(item.amount || 0);
    if (!validModule(module) || !Number.isFinite(amount) || amount < 0 || (status === 'FINALIZADA' && (!String(item.specification || '').trim() || !String(item.justification || '').trim()))) throw httpError(400, 'Preencha os campos obrigatórios de cada item.');
    return { module, specification: String(item.specification).trim(), specialty: isHonor(module) ? String(item.specialty || '').trim() : '', crm: isHonor(module) ? String(item.crm || '').trim() : '', sector: hasSector(module) ? String(item.sector || '').trim().slice(0, 100) : '', justification: String(item.justification).trim(), amount: amount.toFixed(2) };
  });
  if (status === 'FINALIZADA' && !items.length) throw httpError(400, 'Inclua pelo menos um item.');
  const id = await transaction(async (connection) => {
    let id = requestedId;
    const existing = id ? await one('SELECT number, guide_code, ocs, patient, billed, attendance_number, status, finalized_at FROM guides WHERE number=? AND owner_id=?', [id, data.owner], connection) : null;
    if (id && !existing) throw httpError(400, 'Guia não encontrada.');
    if (existing && !guideAccess(existing).editable) throw httpError(400, 'Esta guia foi finalizada há mais de 30 dias e não pode mais ser editada.');
    const previousItems = existing ? await all('SELECT module, specification, specialty, crm, sector, justification, amount FROM guide_items WHERE guide_number=? ORDER BY id', [id], connection) : [];
    const details = guideChanges(existing, previousItems, { guide_code: guideCode, ocs, patient, billed: billed.toFixed(2), attendance_number: attendanceNumber, status, items });
    const finalizedAt = status === 'FINALIZADA' ? (existing ? 'COALESCE(finalized_at, CURRENT_TIMESTAMP)' : 'CURRENT_TIMESTAMP') : 'NULL';
    if (id) await run(`UPDATE guides SET guide_code=?, ocs=?, patient=?, billed=?, attendance_number=?, status=?, finalized_at=${finalizedAt} WHERE number=?`, [guideCode, ocs, patient, billed.toFixed(2), attendanceNumber, status, id], connection);
    else id = Number((await run(`INSERT INTO guides (guide_code, ocs, patient, billed, attendance_number, status, finalized_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ${finalizedAt}, ?)`, [guideCode, ocs, patient, billed.toFixed(2), attendanceNumber, status, data.owner], connection)).lastInsertRowid);
    await run('DELETE FROM guide_items WHERE guide_number=?', [id], connection);
    for (const item of items) await run('INSERT INTO guide_items (guide_number, module, specification, specialty, crm, sector, justification, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, item.module, item.specification, item.specialty, item.crm, item.sector, item.justification, item.amount], connection);
    const action = !existing ? (status === 'FINALIZADA' ? 'Guia criada e finalizada' : 'Guia criada') : status === 'FINALIZADA' && existing.status !== 'FINALIZADA' ? 'Guia finalizada' : details.length ? 'Guia editada' : 'Guia salva sem alterações';
    await run('INSERT INTO guide_edits (guide_number, username, action, details) VALUES (?, ?, ?, ?)', [id, data.username || 'Sistema', action, JSON.stringify(details)], connection);
    // Guia gravada: o rascunho automático do usuário deixa de ser necessário.
    await run('DELETE FROM guide_drafts WHERE username=?', [data.username || ''], connection);
    return id;
  });
  options.invalidate();
  return guide(id, data.owner);
}

async function remove(id, owner, username) {
  const data = await guide(id, owner);
  if (!data) throw httpError(404, 'Guia não encontrada.');
  if (!data.editable) throw httpError(403, 'Esta guia foi finalizada há mais de 30 dias e não pode mais ser excluída.');
  // Exclusão lógica: a guia sai da lista (sem dono, como as de usuário removido), mas guia, itens e histórico ficam no banco.
  await transaction(async (connection) => {
    await run('UPDATE guides SET deleted_owner_id=owner_id, owner_id=NULL, deleted_at=CURRENT_TIMESTAMP WHERE number=?', [id], connection);
    await run('INSERT INTO guide_edits (guide_number, username, action, details) VALUES (?, ?, ?, ?)', [id, username, 'Guia excluída', '[]'], connection);
  });
  options.invalidate();
}

// Rascunho automático: a guia em edição é gravada a cada alteração, sem criar registro nem histórico.
const MAX_DRAFT = 500_000;
async function draft(username) { const row = await one('SELECT payload, updated_at FROM guide_drafts WHERE username=?', [username]); if (!row) return null; try { return { ...JSON.parse(row.payload), updated_at: row.updated_at }; } catch { return null; } }
async function saveDraft(username, payload) {
  const text = JSON.stringify(payload ?? {});
  if (text.length > MAX_DRAFT) throw httpError(413, 'O rascunho excede o limite permitido.');
  const upsert = mysql
    ? 'INSERT INTO guide_drafts (username, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload=VALUES(payload), updated_at=CURRENT_TIMESTAMP'
    : 'INSERT INTO guide_drafts (username, payload) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET payload=excluded.payload, updated_at=CURRENT_TIMESTAMP';
  await run(upsert, [username, text]);
}
const deleteDraft = (username) => run('DELETE FROM guide_drafts WHERE username=?', [username]);

module.exports = { guide, listGuides, dashboard, sameAttendance, history, save, remove, draft, saveDraft, deleteDraft, totals, sumKind };
