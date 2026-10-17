// Backups e monitor de ponta a ponta, num servidor de teste com banco temporário.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decrypt } = require('../lib/backups');

const port = 18082;
const root = path.join(__dirname, '..');
// Arquivo de código "plantado" para o monitor de integridade acusar; removido no final.
const planted = path.join(root, 'public', 'teste-integridade.txt');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sisglosa-backup-'));
const server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), DB_FILE: path.join(folder, 'guias.db'), UPDATE_BACKUP_ROOT: path.join(folder, 'updates') }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverError = '';
server.stdout.resume();
server.stderr.on('data', (chunk) => { serverError += chunk; });
let cookie = '';
async function request(url, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { ...options, headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(options.headers || {}) } });
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response;
}
const post = (url, data) => request(url, { method: 'POST', body: JSON.stringify(data || {}) });
async function wait() {
  for (let attempt = 0; attempt < 50; attempt += 1) { try { if ((await request('/health')).ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  throw new Error(`Servidor de teste não iniciou. ${serverError}`);
}
(async () => {
  try {
    await wait();
    assert.equal((await post('/api/login', { username: 'admin', password: 'Admin@123456' })).status, 200);
    assert.equal((await post('/api/password', { password: 'Admin@Nova1' })).status, 200);

    // Na inicialização já existe um backup automático, conferido.
    let data = await (await request('/api/admin/backups')).json();
    assert.equal(data.enabled, true); assert.equal(data.backups.length, 1); assert.equal(data.backups[0].kind, 'auto'); assert.equal(data.backups[0].ok, true);

    let response = await post('/api/admin/backups'); const manual = await response.json();
    assert.equal(response.status, 201, JSON.stringify(manual)); assert.equal(manual.kind, 'manual'); assert.equal(manual.ok, true); assert.equal(manual.users, 1);

    // Download: senha errada é recusada; o arquivo baixado é cifrado e abre só com a frase-senha.
    assert.equal((await post('/api/admin/backups/download', { name: manual.name, password: 'errada', passphrase: 'frase-de-teste' })).status, 403);
    assert.equal((await post('/api/admin/backups/download', { name: '../guias.db', password: 'Admin@Nova1', passphrase: 'frase-de-teste' })).status, 404);
    response = await post('/api/admin/backups/download', { name: manual.name, password: 'Admin@Nova1', passphrase: 'frase-de-teste' });
    assert.equal(response.status, 200); const encrypted = Buffer.from(await response.arrayBuffer());
    const original = fs.readFileSync(path.join(folder, 'backups', manual.name));
    assert.ok(!encrypted.includes(original.subarray(0, 16))); assert.ok(decrypt(encrypted, 'frase-de-teste').equals(original));
    assert.throws(() => decrypt(encrypted, 'outra-frase'), /incorreta/);

    // Restauração: o usuário criado depois do backup some; o banco anterior fica guardado e todos saem.
    assert.equal((await post('/api/users', { username: 'auditor', role: 'user' })).status, 201);
    assert.equal((await post('/api/admin/backups/restore', { name: manual.name, password: 'Admin@Nova1', confirmation: 'sim' })).status, 400);
    response = await post('/api/admin/backups/restore', { name: manual.name, password: 'Admin@Nova1', confirmation: 'RESTAURAR' }); const restored = await response.json();
    assert.equal(response.status, 200, JSON.stringify(restored)); assert.match(restored.safety, /pre-restore/);
    assert.equal((await request('/api/users')).status, 401);
    assert.equal((await post('/api/login', { username: 'admin', password: 'Admin@Nova1' })).status, 200);
    assert.ok(!(await (await request('/api/users')).json()).some((user) => user.username === 'auditor'));
    assert.equal((await (await request('/api/admin/system')).json()).version, require('../package.json').version);
    data = await (await request('/api/admin/backups')).json();
    assert.deepEqual(data.history.slice(0, 2).map((entry) => entry.action), ['restaurado', 'criado']);

    // Monitor: tudo verde; um arquivo de código novo vira alerta crítico até ser aceito.
    let monitor = await (await request('/api/admin/monitor')).json();
    assert.ok(monitor.latest && monitor.latest.ram > 0); assert.ok(!monitor.open.some((alert) => alert.severity === 'CRITICO'), JSON.stringify(monitor.open));
    fs.writeFileSync(planted, 'plantado');
    monitor = await (await post('/api/admin/monitor/check')).json();
    assert.equal(monitor.health, 'vermelho'); assert.match(monitor.open.find((alert) => alert.alert_key === 'arquivos.alterados').detail, /teste-integridade/);
    assert.equal((await post('/api/admin/monitor/accept', { password: 'errada' })).status, 403);
    monitor = await (await post('/api/admin/monitor/accept', { password: 'Admin@Nova1' })).json();
    assert.ok(!monitor.open.some((alert) => alert.alert_key === 'arquivos.alterados')); assert.ok(monitor.resolved.some((alert) => alert.alert_key === 'arquivos.alterados'));
    console.log('Smoke de backups e monitor: ok.');
  } finally {
    fs.rmSync(planted, { force: true });
    server.kill();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
