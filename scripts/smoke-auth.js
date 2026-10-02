const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const port = 18081;
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sisglosa-auth-'));
const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), DB_FILE: path.join(folder, 'guias.db') } });
let cookie = '';
async function request(url, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { ...options, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) } });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response;
}
async function wait() {
  for (let attempt = 0; attempt < 30; attempt += 1) { try { if ((await request('/health')).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error('Servidor de teste não iniciou.');
}
(async () => {
  try {
    await wait();
    let response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin@123456' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).mustChangePassword, true);
    response = await request('/api/password', { method: 'POST', body: JSON.stringify({ password: 'Admin@Nova1' }) }); assert.equal(response.status, 200);
    response = await request('/api/guides'); assert.equal(response.status, 403);
    response = await request('/api/users', { method: 'POST', body: JSON.stringify({ username: 'auditor' }) }); assert.equal(response.status, 201);
    cookie = '';
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'auditor', password: '123456' }) }); assert.equal((await response.json()).mustChangePassword, true);
    response = await request('/api/password', { method: 'POST', body: JSON.stringify({ password: 'Auditor@123' }) }); assert.equal(response.status, 200);
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ocs: '', patient: '', billed: 0, items: [], status: 'RASCUNHO' }) }); assert.equal((await response.json()).status, 'RASCUNHO');
    response = await request('/api/dashboard'); assert.equal((await response.json()).open, 1);
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ocs: 'OCS teste', patient: 'Paciente teste', attendanceNumber: '2.706.875', billed: 100, status: 'FINALIZADA', items: [{ module: 'Glosa: Taxa personalizada', specification: 'Taxa teste', justification: 'Justificativa registrada pelo auditor.', amount: 20 }, { module: 'Ajuste de honorários', specification: 'Honorário teste', justification: 'Ajuste, será pago R$ 10,00 conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.', amount: 10 }] }) }); const finalized = await response.json(); assert.equal(finalized.status, 'FINALIZADA'); assert.equal(finalized.attendance_number, '2.706.875'); assert.ok(finalized.finalized_at);
    response = await request('/api/options/modules'); assert.ok((await response.json()).includes('Glosa: Taxa personalizada'));
    response = await request('/api/options/justifications'); assert.ok((await response.json()).includes('Justificativa registrada pelo auditor.'));
    response = await request(`/api/guides/${finalized.number}/report`); const report = await response.text(); assert.match(report, /Relatório de Glosas do Atendimento 2\.706\.875/); assert.match(report, /R\$\s*90,00/);
    const database = new DatabaseSync(path.join(folder, 'guias.db')); database.prepare("UPDATE guides SET finalized_at=datetime('now', '-31 days') WHERE number=?").run(finalized.number);
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ...finalized, status: 'FINALIZADA' }) }); assert.equal(response.status, 400);
    database.close();
    cookie = '';
    await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin@Nova1' }) });
    response = await request('/api/users'); assert.equal((await response.json()).length, 2);
    response = await request('/api/users/2', { method: 'DELETE' }); assert.equal(response.status, 200);
    response = await request('/api/users'); assert.equal((await response.json()).length, 1);
    console.log('Auth smoke test OK');
  } finally {
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
