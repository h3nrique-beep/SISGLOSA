// Listas sem dono (de antes da 2.3.1) ganham dono: a justificativa salva por um auditor não aparece para o admin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sisglosa-legado-'));
process.env.DB_FILE = path.join(folder, 'guias.db');
const { initializeDatabase, run, all } = require('../lib/db');
const options = require('../lib/options');

(async () => {
  await initializeDatabase('0.0.0');
  await run("INSERT INTO users (id, username, password_hash, role, roles) VALUES (1, 'admin', 'x', 'admin', 'user,admin'), (2, 'tacya', 'x', 'user', 'user')");
  await run("INSERT INTO saved_justifications (fingerprint, justification) VALUES ('a', 'Glosa salva pela Tacya.')");
  await run("INSERT INTO deleted_justifications (fingerprint, justification) VALUES ('b', 'Excluída por alguém.')");
  await run("INSERT INTO hidden_suggestions (fingerprint, kind, suggestion) VALUES ('c', 'ocs', 'HOSPITAL')");
  await options.adoptLegacy();
  await options.adoptLegacy(); // de novo: não duplica nem falha
  assert.ok((await options.justifications(2)).includes('Glosa salva pela Tacya.'), 'auditora mantém a sua');
  assert.ok(!(await options.justifications(1)).includes('Glosa salva pela Tacya.'), 'admin não vê a da auditora');
  const count = async (table, where) => Number((await all(`SELECT COUNT(*) AS total FROM ${table} WHERE ${where}`))[0].total);
  for (const table of ['saved_justifications', 'deleted_justifications', 'hidden_suggestions']) assert.equal(await count(table, 'owner_id IS NULL'), 0, `${table} sem registro sem dono`);
  assert.equal(await count('saved_justifications', 'owner_id IS NOT NULL'), 1, 'salva vai só para a auditora');
  assert.equal(await count('deleted_justifications', 'owner_id IS NOT NULL'), 2, 'excluída vale para os dois de guias');
  assert.equal(await count('hidden_suggestions', 'owner_id IS NOT NULL'), 2, 'oculta vale para os dois de guias');
  assert.deepEqual(await options.ocs(1), [], 'sugestão oculta continua oculta');
  // Registro de ações: o que passou de 1 ano sai; o resto fica.
  const audit = require('../lib/audit');
  const day = 24 * 60 * 60 * 1000;
  fs.writeFileSync(audit.AUDIT_FILE, [400, 366, 10, 0].map((age) => `${JSON.stringify({ at: Date.now() - age * day, action: 'login', username: `idade-${age}` })}\n`).join(''));
  assert.equal(audit.prune(), 2);
  assert.deepEqual(audit.list().map((entry) => entry.username), ['idade-0', 'idade-10']);
  assert.equal(audit.prune(), 0, 'sem nada vencido não reescreve');
  console.log('Smoke de listas antigas e retenção do registro: ok.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
