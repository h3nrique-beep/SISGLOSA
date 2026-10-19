const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');

const pacote = require('../lib/pacote');

const port = 18081;
// Arquivo criado por um pacote durante o teste (o pacote grava na pasta do projeto); removido no final.
const newFile = 'public/teste-pacote-novo.txt';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sisglosa-auth-'));
const server = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), DB_FILE: path.join(folder, 'guias.db'), UPDATE_BACKUP_ROOT: path.join(folder, 'backups') }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = '';
server.stdout.resume();
server.stderr.on('data', (chunk) => { serverError += chunk; });
let cookie = '';
async function request(url, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { ...options, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) } });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response;
}
async function wait() {
  for (let attempt = 0; attempt < 30; attempt += 1) { try { if ((await request('/health')).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Servidor de teste não iniciou. ${serverError}`);
}
(async () => {
  try {
    await wait();
    let health = await request('/health'); assert.equal(health.headers.get('x-frame-options'), 'DENY'); assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    for (let attempt = 0; attempt < 5; attempt += 1) { const failed = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'bloqueado', password: 'senha-inválida' }) }); assert.equal(failed.status, 401); }
    let blocked = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'bloqueado', password: 'senha-inválida' }) }); assert.equal(blocked.status, 429);
    let response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin@123456' }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).mustChangePassword, true);
    response = await request('/api/password', { method: 'POST', body: JSON.stringify({ password: 'Admin@Nova1' }) }); assert.equal(response.status, 200);
    response = await request('/api/guides'); assert.equal(response.status, 403);
    response = await request('/api/admin/system'); assert.equal(response.status, 200); assert.equal((await response.json()).version, '2.0.0');
    response = await request('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': 'invalido.zip' }, body: Buffer.from('invalido') }); assert.equal(response.status, 400);
    const upload = (zip, name = 'pacote.zip') => request('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': name }, body: zip });
    const pack = (manifest, files) => { const zip = new AdmZip(); zip.addFile('sisglosa-update.json', Buffer.from(JSON.stringify({ product: 'SISGLOSA', ...manifest }))); for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content)); return zip.toBuffer(); };
    const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css')), appFile = path.join(__dirname, '..', 'public', 'app.js'), appBefore = fs.readFileSync(appFile);
    response = await upload(pack({ version: '2.0.1', files: ['public/styles.css'] }, { 'public/styles.css': styles })); assert.equal(response.status, 400); assert.match((await response.json()).error, /o que mudou/);
    response = await upload(pack({ version: '2.0.1', message: 'x', type: 'qualquer', files: ['public/styles.css'] }, { 'public/styles.css': styles })); assert.equal(response.status, 400);
    response = await upload(pack({ version: '2.0.1', message: 'quebrado', files: ['public/app.js'] }, { 'public/app.js': 'function (' })); assert.equal(response.status, 400); assert.match((await response.json()).error, /sintaxe/); assert.ok(fs.readFileSync(appFile).equals(appBefore));
    const generator = path.join(__dirname, 'gerar-pacote.js'), packages = path.join(folder, 'pacotes');
    assert.notEqual(spawnSync(process.execPath, [generator, '--versao', '2.0.2', '--mensagem', 'x', '--arquivos', 'data/guias.db', '--saida', packages], { encoding: 'utf8' }).status, 0);
    for (const allowed of ['server.js', 'lib/novo.js', 'public/img/a.png', 'package.json', 'deploy/proxmox/nginx.conf']) assert.ok(pacote.allowedFile(allowed), allowed);
    for (const blockedFile of ['data/guias.db', 'node_modules/a.js', '.env', 'lib/../data/x', '/etc/passwd', 'lib\\x.js', 'public/.htaccess', '.git/config', 'src/A.java']) assert.ok(!pacote.allowedFile(blockedFile), blockedFile);
    const outside = new AdmZip(); outside.addFile('data/guias.db', Buffer.from('x'));
    response = await request('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': 'fora.zip', 'X-Update-Version': '9.0.0', 'X-Update-Type': 'corretiva', 'X-Update-Message': 'fora' }, body: outside.toBuffer() }); assert.equal(response.status, 400); assert.match((await response.json()).error, /não permitidos/);
    const generated = spawnSync(process.execPath, [generator, '--versao', '2.0.1', '--mensagem', 'Ajuste de estilos', '--arquivos', 'public/styles.css', '--saida', packages], { encoding: 'utf8' }); assert.equal(generated.status, 0, generated.stderr);
    response = await upload(fs.readFileSync(path.join(packages, 'sisglosa-2.0.1.zip')), 'sisglosa-2.0.1.zip'); const applied = await response.json(); assert.equal(response.status, 201, JSON.stringify(applied));
    assert.equal(applied.version, '2.0.1'); assert.equal(applied.type, 'corretiva'); assert.equal(applied.message, 'Ajuste de estilos'); assert.equal(applied.restartRequired, false);
    assert.ok(fs.existsSync(path.join(applied.backup, 'guias.db')) && fs.existsSync(path.join(applied.backup, 'public', 'styles.css')));
    response = await request('/api/admin/updates'); const updates = await response.json(); assert.equal(updates[0].message, 'Ajuste de estilos'); assert.equal(updates[0].kind, 'corretiva');
    const plain = new AdmZip(); plain.addFile('public/styles.css', styles);
    const panelUpload = (version, type, message) => request('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': 'painel.zip', 'X-Update-Version': version, 'X-Update-Type': type, 'X-Update-Message': encodeURIComponent(message) }, body: plain.toBuffer() });
    response = await panelUpload('2.0.1', 'corretiva', '.'); assert.equal(response.status, 400); assert.match((await response.json()).error, /o que mudou/);
    response = await panelUpload('2.1.0', 'evolutiva', 'Nova tela de atualização'); const evolved = await response.json(); assert.equal(response.status, 201, JSON.stringify(evolved)); assert.equal(evolved.type, 'evolutiva'); assert.equal(evolved.message, 'Nova tela de atualização');
    // Reversão: pacote de versão menor é aceito; com manifesto, versão e descrição vêm dele mesmo que o painel mande só ".".
    response = await request('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': 'sisglosa-2.0.1.zip', 'X-Update-Version': '9.9.9', 'X-Update-Type': 'corretiva', 'X-Update-Message': '.' }, body: fs.readFileSync(path.join(packages, 'sisglosa-2.0.1.zip')) }); const reverted = await response.json();
    assert.equal(response.status, 201, JSON.stringify(reverted)); assert.equal(reverted.version, '2.0.1'); assert.equal(reverted.reverted, true); assert.equal(reverted.message, 'Ajuste de estilos');
    response = await panelUpload('2.1.0', 'evolutiva', 'Volta para a 2.1.0'); assert.equal(response.status, 201);
    // Arquivo novo no pacote é criado; pacote recusado não deixa nada para trás.
    const brokenNew = new AdmZip(); brokenNew.addFile(newFile, Buffer.from('novo')); brokenNew.addFile('lib/quebrado.js', Buffer.from('function ('));
    response = await request('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': 'novo.zip', 'X-Update-Version': '2.2.0', 'X-Update-Type': 'evolutiva', 'X-Update-Message': 'novo' }, body: brokenNew.toBuffer() }); assert.equal(response.status, 400); assert.ok(!fs.existsSync(path.join(__dirname, '..', newFile)));
    const withNew = new AdmZip(); withNew.addFile(newFile, Buffer.from('novo'));
    response = await request('/api/admin/updates', { method: 'POST', headers: { 'Content-Type': 'application/zip', 'X-Update-Filename': 'novo.zip', 'X-Update-Version': '2.2.0', 'X-Update-Type': 'evolutiva', 'X-Update-Message': 'arquivo novo' }, body: withNew.toBuffer() }); const createdPackage = await response.json(); assert.equal(response.status, 201, JSON.stringify(createdPackage)); assert.deepEqual(createdPackage.created, [newFile]); assert.equal(createdPackage.restartRequired, false);
    assert.equal(fs.readFileSync(path.join(__dirname, '..', newFile), 'utf8'), 'novo');
    response = await request('/api/users', { method: 'POST', body: JSON.stringify({ username: 'auditor' }) }); assert.equal(response.status, 201); const auditor = await response.json(); assert.equal(auditor.temporaryPassword, '123456');
    response = await request('/api/users', { method: 'POST', body: JSON.stringify({ username: 'administrador', role: 'admin' }) }); assert.equal(response.status, 201); assert.equal((await response.json()).role, 'admin');
    // Perfis múltiplos: admin dá Guias ao "administrador", que alterna entre os dois perfis.
    response = await request('/api/users'); const multi = (await response.json()).find((user) => user.username === 'administrador'); assert.deepEqual(multi.roles, ['admin']);
    response = await request(`/api/users/${multi.id}/roles`, { method: 'PUT', body: JSON.stringify({ roles: [] }) }); assert.equal(response.status, 400);
    response = await request(`/api/users/${multi.id}/roles`, { method: 'PUT', body: JSON.stringify({ roles: ['admin', 'user'] }) }); assert.deepEqual((await response.json()).roles, ['user', 'admin']);
    response = await request('/api/users/1/roles', { method: 'PUT', body: JSON.stringify({ roles: ['user'] }) }); assert.equal(response.status, 400, 'admin não perde o próprio perfil');
    response = await request('/api/session/role', { method: 'POST', body: JSON.stringify({ role: 'user' }) }); assert.equal(response.status, 403, 'admin sem perfil de guias não troca');
    cookie = '';
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'administrador', password: '123456' }) }); { const data = await response.json(); assert.equal(data.role, 'admin'); assert.deepEqual(data.roles, ['user', 'admin']); }
    await request('/api/password', { method: 'POST', body: JSON.stringify({ password: 'Multi@1234' }) });
    response = await request('/api/dashboard'); assert.equal(response.status, 403);
    response = await request('/api/session/role', { method: 'POST', body: JSON.stringify({ role: 'user' }) }); assert.equal((await response.json()).role, 'user');
    response = await request('/api/dashboard'); assert.equal(response.status, 200);
    response = await request('/api/users'); assert.equal(response.status, 403);
    response = await request('/api/session/role', { method: 'POST', body: JSON.stringify({ role: 'root' }) }); assert.equal(response.status, 403);
    cookie = '';
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'auditor', password: auditor.temporaryPassword }) }); { const data = await response.json(); assert.equal(data.mustChangePassword, true); assert.match(data.version, /^\d+\.\d+\.\d+$/, "auditor recebe a versão ativa"); }
    response = await request('/api/password', { method: 'POST', body: JSON.stringify({ password: '123456' }) }); assert.equal(response.status, 400);
    response = await request('/api/password', { method: 'POST', body: JSON.stringify({ password: 'Auditor@123' }) }); assert.equal(response.status, 200);
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ocs: '', patient: '', billed: 0, items: [], status: 'RASCUNHO' }) }); assert.equal((await response.json()).status, 'RASCUNHO');
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ number: 'inválido', ocs: '', patient: '', billed: 0, items: [], status: 'RASCUNHO' }) }); assert.equal(response.status, 400);
    response = await request('/api/dashboard'); assert.equal((await response.json()).open, 1);
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ guideCode: 'G-2026/123', ocs: 'OCS teste', patient: 'Paciente teste', attendanceNumber: '2.706.875', billed: 100, status: 'FINALIZADA', items: [{ module: 'Glosa: Taxa personalizada', specification: 'Taxa teste', justification: 'Justificativa registrada pelo auditor.', amount: 20 }, { module: 'Ajuste de honorários', specification: 'Honorário teste', justification: 'Ajuste, será pago R$ 10,00 conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.', amount: 10 }] }) }); const finalized = await response.json(); assert.equal(finalized.status, 'FINALIZADA'); assert.equal(finalized.attendance_number, '2.706.875'); assert.ok(finalized.finalized_at);
    // Registros: filtros e aviso de atendimento repetido.
    const count = async (filter) => (await (await request(`/api/guides?${new URLSearchParams(filter)}`)).json()).length;
    assert.equal(await count({ status: 'FINALIZADA' }), 1); assert.equal(await count({ q: '2.706' }), 1); assert.equal(await count({ ocs: 'inexistente' }), 0); assert.equal(await count({ from: '2999-01-01' }), 0); assert.equal(await count({ to: '2999-01-01' }), 2);
    response = await request('/api/guides/attendance?number=2.706.875'); assert.equal((await response.json())[0].number, finalized.number);
    response = await request(`/api/guides/attendance?number=2.706.875&exclude=${finalized.number}`); assert.equal((await response.json()).length, 0);
    response = await request('/api/draft', { method: 'PUT', body: JSON.stringify({ ocs: 'Rascunho no servidor', items: [] }) }); assert.equal(response.status, 200);
    response = await request('/api/draft'); assert.equal((await response.json()).ocs, 'Rascunho no servidor');
    response = await request('/api/dashboard'); const panel = await response.json(); assert.deepEqual([panel.billed, panel.glosa, panel.ajuste], [0, 0, 0], 'guia finalizada fica fora dos valores do painel');
    response = await request('/api/options/patients'); assert.ok((await response.json()).includes('Paciente teste'));
    response = await request('/api/options/patients', { method: 'DELETE', body: JSON.stringify({ value: 'Paciente teste' }) }); assert.equal(response.status, 200);
    response = await request('/api/options/patients'); assert.ok(!(await response.json()).includes('Paciente teste'), 'sugestão removida não volta');
    response = await request(`/api/guides/${finalized.number}/history`); const history = await response.json(); assert.equal(history[0].action, 'Guia criada e finalizada'); assert.equal(history[0].username, 'auditor');
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ number: finalized.number, guideCode: finalized.guide_code, ocs: finalized.ocs, patient: 'Paciente atualizado', attendanceNumber: finalized.attendance_number, billed: finalized.billed, status: 'FINALIZADA', items: finalized.items.map((item, index) => ({ ...item, amount: index === 0 ? 25 : item.amount })) }) }); assert.equal(response.status, 201);
    response = await request('/api/draft'); assert.equal(await response.json(), null, 'gravar a guia apaga o rascunho automático');
    response = await request(`/api/guides/${finalized.number}/history`); const editedHistory = await response.json(); assert.equal(editedHistory[0].action, 'Guia editada'); assert.ok(editedHistory[0].details.some((detail) => detail.includes('Paciente: Paciente teste → Paciente atualizado'))); assert.ok(editedHistory[0].details.some((detail) => detail.includes('Item 1') && detail.includes('Valor')));
    response = await request('/api/options/modules'); assert.ok((await response.json()).includes('Glosa: Taxa personalizada'));
    response = await request('/api/options/justifications'); const justifications = await response.json(); assert.ok(justifications.includes('Ajuste, será pago R$ conforme as regras da CBHPM Edição 2014 e de acordo com o item 5 do referencial de custos do contrato.')); assert.ok(justifications.includes('Justificativa registrada pelo auditor.'));
    response = await request('/api/options/justifications', { method: 'DELETE', body: JSON.stringify({ justification: 'Justificativa registrada pelo auditor.' }) }); assert.equal(response.status, 200);
    response = await request('/api/options/justifications'); assert.ok(!(await response.json()).includes('Justificativa registrada pelo auditor.'));
    response = await request('/api/options/justifications', { method: 'POST', body: JSON.stringify({ justification: 'Texto privado do auditor.' }) }); assert.equal(response.status, 201);
    // Exclusão lógica: some para o usuário, mas guia e histórico ficam no banco.
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ocs: 'Para excluir', patient: '', billed: 0, items: [], status: 'RASCUNHO' }) }); const doomed = await response.json();
    response = await request(`/api/guides/${doomed.number}`, { method: 'DELETE' }); assert.equal(response.status, 200);
    response = await request(`/api/guides/${doomed.number}`); assert.equal(response.status, 404);
    response = await request(`/api/guides/${finalized.number}/report`); const report = await response.text(); assert.match(report, /Relatório de Glosas do Atendimento 2\.706\.875/); assert.match(report, /GUIA Nº: G-2026\/123/); assert.equal(await count({ q: 'g-2026' }), 1); assert.match(report, /R\$\s*85,00/);
    const database = new DatabaseSync(path.join(folder, 'guias.db')); database.prepare("UPDATE guides SET finalized_at=datetime('now', '-31 days') WHERE number=?").run(finalized.number);
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ...finalized, status: 'FINALIZADA' }) }); assert.equal(response.status, 400);
    response = await request(`/api/guides/${finalized.number}`, { method: 'DELETE' }); assert.equal(response.status, 403);
    { const kept = database.prepare('SELECT owner_id, deleted_owner_id, deleted_at FROM guides WHERE number=?').get(doomed.number); assert.equal(kept.owner_id, null); assert.ok(kept.deleted_owner_id && kept.deleted_at, 'guia excluída continua no banco');
      assert.equal(database.prepare('SELECT action FROM guide_edits WHERE guide_number=? ORDER BY id DESC').get(doomed.number).action, 'Guia excluída'); }
    // Hash antigo (120 mil iterações, "salt:digest") ainda entra e é refeito com 600 mil no login.
    { const salt = crypto.randomBytes(16); database.prepare("UPDATE users SET password_hash=? WHERE username='administrador'").run(`${salt.toString('base64')}:${crypto.pbkdf2Sync('Multi@1234', salt, 120000, 32, 'sha256').toString('base64')}`); }
    database.close();
    // Justificativa salva por um auditor não aparece para outro usuário de guias.
    cookie = '';
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'administrador', password: 'Multi@1234' }) }); assert.equal(response.status, 200);
    { const check = new DatabaseSync(path.join(folder, 'guias.db')); assert.match(check.prepare("SELECT password_hash FROM users WHERE username='administrador'").get().password_hash, /^600000:/); check.close(); }
    await request('/api/session/role', { method: 'POST', body: JSON.stringify({ role: 'user' }) });
    response = await request('/api/options/justifications'); assert.ok(!(await response.json()).includes('Texto privado do auditor.'), 'justificativa é de cada usuário');
    cookie = '';
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'senha-errada' }) }); assert.equal(response.status, 401);
    response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'ninguem', password: 'x' }) }); assert.equal(response.status, 401);
    await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin@Nova1' }) });
    { const log = await (await request('/api/admin/audit')).json(); const actions = log.entries.map((entry) => entry.action); assert.equal(log.days.length, 1, 'um dia com uso');
      for (const action of ['login', 'login_falhou', 'usuario_criado', 'perfis_alterados', 'perfil_trocado', 'senha_trocada', 'guia_excluida']) assert.ok(actions.includes(action), `registro tem ${action}`); }
    response = await request('/api/users'); assert.equal((await response.json()).length, 3);
    response = await request('/api/users/2', { method: 'DELETE' }); assert.equal(response.status, 200);
    response = await request('/api/users'); assert.equal((await response.json()).length, 2);
    // Usuário recriado com o mesmo nome começa do zero: não vê guias, sugestões nem rascunho de quem existia antes.
    const stale = new DatabaseSync(path.join(folder, 'guias.db')); stale.prepare("INSERT INTO guide_drafts (username, payload) VALUES ('auditor', '{\"ocs\":\"rascunho antigo\"}')").run(); stale.close();
    response = await request('/api/users', { method: 'POST', body: JSON.stringify({ username: 'auditor' }) }); assert.equal(response.status, 201); const recreated = await response.json();
    cookie = '';
    await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'auditor', password: recreated.temporaryPassword }) });
    response = await request('/api/password', { method: 'POST', body: JSON.stringify({ password: 'Auditor@456' }) }); assert.equal(response.status, 200);
    response = await request('/api/guides'); assert.deepEqual(await response.json(), [], 'usuário novo não vê guias antigas');
    response = await request('/api/dashboard'); assert.equal((await response.json()).total, 0);
    response = await request(`/api/guides/${finalized.number}`); assert.equal(response.status, 404);
    response = await request(`/api/guides/${finalized.number}/history`); assert.equal(response.status, 404);
    response = await request(`/api/guides/${finalized.number}/report`); assert.equal(response.status, 404);
    response = await request(`/api/guides/${finalized.number}`, { method: 'DELETE' }); assert.equal(response.status, 404);
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ...finalized, patient: 'Invasor', status: 'RASCUNHO' }) }); assert.equal(response.status, 400, 'não edita guia de outro usuário');
    response = await request('/api/guides/attendance?number=2.706.875'); assert.deepEqual(await response.json(), []);
    response = await request('/api/draft'); assert.equal(await response.json(), null, 'rascunho do usuário antigo foi descartado');
    response = await request('/api/options/ocs'); assert.deepEqual(await response.json(), []);
    response = await request('/api/options/specifications?module=Ajuste%20de%20honor%C3%A1rios'); assert.deepEqual(await response.json(), []);
    response = await request('/api/options/modules'); assert.ok(!(await response.json()).includes('Glosa: Taxa personalizada'));
    response = await request('/api/guides', { method: 'POST', body: JSON.stringify({ ocs: 'OCS novo', patient: 'Paciente novo', billed: 0, items: [], status: 'RASCUNHO' }) }); assert.equal(response.status, 201);
    response = await request('/api/guides'); assert.equal((await response.json()).length, 1, 'vê só a própria guia');
    response = await request('/api/options/patients'); assert.deepEqual(await response.json(), ['Paciente novo']);
    cookie = '';
    await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'Admin@Nova1' }) });
    const setAdmin = spawnSync(process.execPath, [path.join(__dirname, 'definir-admin.js'), '--remover-outros'], { encoding: 'utf8', env: { ...process.env, DB_FILE: path.join(folder, 'guias.db'), ADMIN_PASSWORD: 'senha-simples1' } }); assert.equal(setAdmin.status, 0, setAdmin.stderr); assert.match(setAdmin.stderr, /política/); assert.ok(!setAdmin.stdout.includes('senha-simples1'));
    cookie = ''; response = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'senha-simples1' }) }); assert.equal(response.status, 200); assert.equal((await response.json()).mustChangePassword, false);
    response = await request('/api/users'); assert.equal((await response.json()).length, 1);
    console.log('Auth smoke test OK');
  } finally {
    fs.rmSync(path.join(__dirname, '..', newFile), { force: true });
    server.kill();
    await new Promise((resolve) => server.once('exit', resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
