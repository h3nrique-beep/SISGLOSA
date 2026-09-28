const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const mysql = process.env.DB_HOST ? require('mysql2/promise') : null;

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8081);
const MODULES = [
  'Ajuste de honorários', 'Ajuste de exame laboratorial', 'Ajuste de exame de imagem',
  'Glosa de honorário médico', 'Glosa de taxa', 'Glosa de material', 'Glosa de medicamento',
  'Glosa de exame de imagem', 'Glosa de exame laboratorial', 'Glosa de nutrição', 'Glosa de OPME', 'Glosa de fisioterapia',
];
const sessions = new Map();
let db;
const databaseFile = process.env.DB_FILE || path.join(ROOT, 'data', 'guias.db');
const reportLogo = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'public', 'template-logo.png')).toString('base64')}`;

async function all(sql, params = [], connection = db) {
  if (mysql) return (await connection.execute(sql, params))[0];
  return connection.prepare(sql).all(...params);
}
async function one(sql, params = [], connection = db) { return (await all(sql, params, connection))[0]; }
async function run(sql, params = [], connection = db) {
  if (mysql) {
    const [result] = await connection.execute(sql, params);
    return { changes: result.affectedRows, lastInsertRowid: result.insertId };
  }
  return connection.prepare(sql).run(...params);
}
async function transaction(work) {
  if (!mysql) {
    db.exec('BEGIN');
    try { const result = await work(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const connection = await db.getConnection();
  try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
}
async function initializeDatabase() {
  if (!mysql) fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  db = mysql ? mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10 }) : new DatabaseSync(databaseFile);
  if (!mysql) db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const id = mysql ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'INTEGER PRIMARY KEY';
  const money = mysql ? 'DECIMAL(12,2)' : 'TEXT';
  const createdAt = mysql ? 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' : 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP';
  const text = mysql ? 'VARCHAR(255)' : 'TEXT';
  const longText = mysql ? 'TEXT' : 'TEXT';
  const execute = (sql) => mysql ? db.query(sql) : Promise.resolve(db.exec(sql));
  await execute(`CREATE TABLE IF NOT EXISTS users (id ${id}, username ${text} NOT NULL UNIQUE, password_hash ${text} NOT NULL)`);
  await execute(`CREATE TABLE IF NOT EXISTS guides (number ${id}, ocs ${text} NOT NULL, patient ${text} NOT NULL, billed ${money} NOT NULL, specialty ${text} NOT NULL DEFAULT '', crm ${text} NOT NULL DEFAULT '', status ${text} NOT NULL DEFAULT 'RASCUNHO', created_at ${createdAt})`);
  await execute(`CREATE TABLE IF NOT EXISTS guide_items (id ${id}, guide_number INT NOT NULL, module ${text} NOT NULL, specification ${text} NOT NULL, specialty ${text} NOT NULL DEFAULT '', crm ${text} NOT NULL DEFAULT '', justification ${longText} NOT NULL, amount ${money} NOT NULL, FOREIGN KEY (guide_number) REFERENCES guides(number))`);
  const userColumns = mysql ? await all('SHOW COLUMNS FROM users') : await all('PRAGMA table_info(users)');
  const names = new Set(userColumns.map((column) => mysql ? column.Field : column.name));
  if (!names.has('role')) await execute(`ALTER TABLE users ADD COLUMN role ${text} NOT NULL DEFAULT 'user'`);
  if (!names.has('must_change_password')) await execute(`ALTER TABLE users ADD COLUMN must_change_password ${mysql ? 'TINYINT(1)' : 'INTEGER'} NOT NULL DEFAULT 1`);
  const guideColumns = mysql ? await all('SHOW COLUMNS FROM guides') : await all('PRAGMA table_info(guides)');
  if (!new Set(guideColumns.map((column) => mysql ? column.Field : column.name)).has('status')) { await execute(`ALTER TABLE guides ADD COLUMN status ${text} NOT NULL DEFAULT 'RASCUNHO'`); await execute("UPDATE guides SET status='FINALIZADA'"); }
  if (!mysql) db.exec(`UPDATE guide_items SET specialty=COALESCE((SELECT specialty FROM guides WHERE number=guide_number), '') WHERE specialty=''; UPDATE guide_items SET crm=COALESCE((SELECT crm FROM guides WHERE number=guide_number), '') WHERE crm='';`);
}

function hash(password, salt = crypto.randomBytes(16)) {
  return `${salt.toString('base64')}:${crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('base64')}`;
}
function passwordMatches(password, saved) {
  const [salt, value] = String(saved || '').split(':');
  if (!salt || !value) return false;
  return crypto.timingSafeEqual(crypto.pbkdf2Sync(password, Buffer.from(salt, 'base64'), 120000, 32, 'sha256'), Buffer.from(value, 'base64'));
}
function strongPassword(password) { return typeof password === 'string' && password.length >= 8 && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password); }
function sessionData(session) { return { username: session.username, role: session.role, mustChangePassword: Boolean(session.mustChangePassword) }; }
function clearUserSessions(username) { for (const [id, session] of sessions) if (session.username === username) sessions.delete(id); }
const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const money = (value) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
const isHonor = (module) => module.includes('honorário');
const cookie = (request, name) => Object.fromEntries((request.headers.cookie || '').split(';').map((part) => part.trim().split('=')))[name];
const json = (response, status, value, headers = {}) => response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value));
const fail = (response, status, message) => json(response, status, { error: message });
const authenticated = (request) => { const session = sessions.get(cookie(request, 'PMGU_SESSION')); return session && session.expires > Date.now() ? session : null; };

function body(request) {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) request.destroy(); });
    request.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Dados inválidos.')); } });
    request.on('error', reject);
  });
}
async function guide(id) {
  const data = await one('SELECT number, ocs, patient, billed, status FROM guides WHERE number=?', [id]);
  if (!data) return null;
  data.items = (await all('SELECT module, specification, specialty, crm, justification, amount FROM guide_items WHERE guide_number=? ORDER BY id', [id])).map((item) => ({ ...item, amount: Number(item.amount) }));
  data.billed = Number(data.billed);
  return data;
}
async function listGuides(status) { const valid = ['RASCUNHO', 'FINALIZADA'].includes(status); return (await all(`SELECT number, ocs, patient, billed, status, created_at FROM guides${valid ? ' WHERE status=?' : ''} ORDER BY number DESC LIMIT 100`, valid ? [status] : [])).map((item) => ({ ...item, billed: Number(item.billed) })); }
async function dashboard() { const counts = await one("SELECT COUNT(*) AS total, SUM(CASE WHEN status='RASCUNHO' THEN 1 ELSE 0 END) AS open, SUM(CASE WHEN status='FINALIZADA' THEN 1 ELSE 0 END) AS finalized FROM guides"); return { total: Number(counts.total || 0), open: Number(counts.open || 0), finalized: Number(counts.finalized || 0), recent: (await listGuides()).slice(0, 5) }; }
function totals(items, billed) {
  const glosa = items.filter((item) => item.module.startsWith('Glosa')).reduce((sum, item) => sum + Number(item.amount), 0);
  const ajuste = items.filter((item) => item.module.startsWith('Ajuste')).reduce((sum, item) => sum + Number(item.amount), 0);
  return { glosa, ajuste, auditado: Number(billed) - glosa - ajuste };
}
function reportPage(data) { return reportPageBody(data).replace('</head>', '<style>@page{size:A4;margin:11.09mm 9.42mm 14.94mm 10.81mm}*{box-sizing:border-box}body{width:auto!important;margin:0!important;padding:0!important}table{max-width:100%!important}h3{border:1px solid #000;border-bottom:0;margin:12px 0 0!important;padding:2px}h3+table{margin-top:0!important}table:not(.summary){table-layout:fixed}table:not(.summary) th:nth-child(1),table:not(.summary) td:nth-child(1){width:5.25%}table:not(.summary) th:nth-child(2),table:not(.summary) td:nth-child(2){width:37.22%}table:not(.summary) th:nth-child(3),table:not(.summary) td:nth-child(3){width:46.84%}table:not(.summary) th:nth-child(4),table:not(.summary) td:nth-child(4){width:10.69%}</style></head>'); }
function reportPageBody(data) {
  const summary = totals(data.items, data.billed);
  const sections = ['Ajuste', 'Glosa'].map((prefix) => {
    const groups = MODULES.filter((module) => module.startsWith(prefix)).map((module) => [module, data.items.filter((item) => item.module === module)]).filter(([, items]) => items.length);
    if (!groups.length) return '';
    return `<h2>RELATÓRIO DE ${prefix.toUpperCase()}</h2>${groups.map(([module, items]) => {
      const honor = isHonor(module); const total = items.reduce((sum, item) => sum + Number(item.amount), 0); const label = module === 'Ajuste de honorários' ? 'Honorários - Ajuste' : module.toUpperCase();
      return `<h3>${escape(label)}</h3><table><thead><tr><th>Item</th><th>Especificação</th><th>Justificativa</th><th>${prefix}</th></tr></thead><tbody>${items.map((item, index) => { const details = [item.specification, honor && item.specialty, honor && item.crm ? `CRM: ${item.crm}` : ''].filter(Boolean).join(' - '); return `<tr><td>${index + 1}</td><td>${escape(details)}</td><td>${escape(item.justification).replaceAll('\n', '<br>')}</td><td class="money">${money(item.amount)}</td></tr>`; }).join('')}</tbody><tfoot><tr><th colspan="3">Total de ${escape(label)}</th><th class="money">${money(total)}</th></tr></tfoot></table>`;
    }).join('')}`;
  }).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de Glosa e Ajuste</title><style>body{width:190mm;margin:0 auto;padding:9mm;font:9pt 'Times New Roman',serif;color:#000}.official{text-align:center;font:700 8pt Arial;line-height:1.2;margin-bottom:9px}.official img{display:block;width:24px;max-height:32px;object-fit:contain;margin:auto}.identity{font-weight:700;line-height:1.35}h2,h3{text-align:center}h2{font-size:12pt;margin:18px 0 8px}h3{font-size:10pt;margin:12px 0 4px}table{border-collapse:collapse;width:100%;margin:6px 0 12px}th,td{border:1px solid #000;padding:3px;vertical-align:top;text-align:left}th{text-align:center}.summary{table-layout:fixed}.summary th:nth-child(1),.summary td:nth-child(1){width:14.35%}.summary th:nth-child(2),.summary td:nth-child(2){width:14.35%}.summary th:nth-child(3),.summary td:nth-child(3){width:11.67%}.summary th:nth-child(4),.summary td:nth-child(4){width:14.91%}.summary th:nth-child(5),.summary td:nth-child(5){width:44.72%}.summary td{height:54px}.observation{font-size:8pt}.money{text-align:right;white-space:nowrap}tfoot th{text-align:right}@media print{body{margin:0}}</style></head><body><div class="official"><img src="${reportLogo}" alt="Exército Brasileiro">MINISTÉRIO DA DEFESA<br>EXÉRCITO BRASILEIRO<br>CMDO 15ª BDA INF MEC</div><p class="identity">OCS: ${escape(data.ocs)}<br>PACIENTE: ${escape(data.patient)}<br>GUIA Nº: ${escape(data.number)}</p><table class="summary"><thead><tr><th>Valor<br>Apresentado</th><th>Glosa</th><th>Ajuste</th><th>Valor<br>Auditado</th><th>Observação</th></tr></thead><tbody><tr><td class="money">${money(data.billed)}</td><td class="money">${money(summary.glosa)}</td><td class="money">${money(summary.ajuste)}</td><td class="money">${money(summary.auditado)}</td><td class="observation">Com relação às glosas e possíveis recursos, favor cumprir rigorosamente os prazos e procedimentos previstos nas cláusulas 7.1.21 até a cláusula 7.1.31 do Termo de Contrato celebrado entre as partes.</td></tr></tbody></table>${sections}<p style="margin-top:26px">Quartel em Cascavel-PR, ${new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' })}</p><div style="display:flex;gap:20px;margin-top:38px;font:9pt Arial"><div style="width:45%;border-top:1px solid;text-align:center;padding-top:4px">Médico Auditor da Seção de Auditoria de Contas Médicas</div><div style="width:45%;border-top:1px solid;text-align:center;padding-top:4px">Enfermeira Auditora da Seção de Auditoria de Contas Médicas</div></div><script>window.addEventListener('load', () => window.print())</script></body></html>`;
}
async function save(data) {
  const status = data.status === 'FINALIZADA' ? 'FINALIZADA' : 'RASCUNHO';
  const ocs = String(data.ocs || '').trim(), patient = String(data.patient || '').trim(), billed = Number(data.billed || 0);
  if (status === 'FINALIZADA' && (!ocs || !patient)) throw new Error('Informe OCS e paciente.');
  if (!Number.isFinite(billed) || billed < 0) throw new Error('Valor apresentado inválido.');
  const items = (Array.isArray(data.items) ? data.items : []).map((item) => {
    const module = String(item.module || ''); const amount = Number(item.amount || 0);
    if (!MODULES.includes(module) || !Number.isFinite(amount) || amount < 0 || (status === 'FINALIZADA' && (!String(item.specification || '').trim() || !String(item.justification || '').trim()))) throw new Error('Preencha os campos obrigatórios de cada item.');
    return { module, specification: String(item.specification).trim(), specialty: isHonor(module) ? String(item.specialty || '').trim() : '', crm: isHonor(module) ? String(item.crm || '').trim() : '', justification: String(item.justification).trim(), amount: amount.toFixed(2) };
  });
  if (status === 'FINALIZADA' && !items.length) throw new Error('Inclua pelo menos um item.');
  const id = await transaction(async (connection) => {
    let id = Number(data.number || 0);
    if (id && !(await run('UPDATE guides SET ocs=?, patient=?, billed=?, status=? WHERE number=?', [ocs, patient, billed.toFixed(2), status, id], connection)).changes) throw new Error('Guia não encontrada.');
    else id = Number((await run('INSERT INTO guides (ocs, patient, billed, status) VALUES (?, ?, ?, ?)', [ocs, patient, billed.toFixed(2), status], connection)).lastInsertRowid);
    await run('DELETE FROM guide_items WHERE guide_number=?', [id], connection);
    for (const item of items) await run('INSERT INTO guide_items (guide_number, module, specification, specialty, crm, justification, amount) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, item.module, item.specification, item.specialty, item.crm, item.justification, item.amount], connection);
    return id;
  });
  return guide(id);
}
function serve(response, file, type) { response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); response.end(fs.readFileSync(file)); }

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`); const pathname = url.pathname;
    if (pathname === '/styles.css') return serve(response, path.join(ROOT, 'public', 'styles.css'), 'text/css; charset=utf-8');
    if (pathname === '/app.js') return serve(response, path.join(ROOT, 'public', 'app.js'), 'application/javascript; charset=utf-8');
    if (pathname === '/template-logo.png') return serve(response, path.join(ROOT, 'public', 'template-logo.png'), 'image/png');
    if (pathname === '/sisglosa.jpg') return serve(response, path.join(ROOT, 'public', 'sisglosa.jpg'), 'image/jpeg');
    if (['/', '/login', '/guias', '/registros', '/administracao', '/desenvolvedor', '/index.html'].includes(pathname)) return serve(response, path.join(ROOT, 'public', 'index.html'), 'text/html; charset=utf-8');
    if (pathname === '/health') { await one('SELECT 1'); return json(response, 200, { status: 'ok' }); }
    if (pathname === '/api/login' && request.method === 'POST') { const data = await body(request); const saved = await one('SELECT username, password_hash, role, must_change_password FROM users WHERE username=?', [String(data.username || '')]); if (!saved || !passwordMatches(String(data.password || ''), saved.password_hash)) return fail(response, 401, 'Usuário ou senha inválidos.'); const id = crypto.randomUUID(); const session = { username: saved.username, role: saved.role, mustChangePassword: saved.must_change_password, expires: Date.now() + 8 * 60 * 60 * 1000 }; sessions.set(id, session); return json(response, 200, sessionData(session), { 'Set-Cookie': `PMGU_SESSION=${id}; HttpOnly; SameSite=Lax; Path=/` }); }
    if (pathname === '/api/logout' && request.method === 'POST') { sessions.delete(cookie(request, 'PMGU_SESSION')); return json(response, 200, {}, { 'Set-Cookie': 'PMGU_SESSION=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/' }); }
    const session = authenticated(request); if (!session) return fail(response, 401, 'Sessão expirada.');
    if (pathname === '/api/session') return json(response, 200, sessionData(session));
    if (pathname === '/api/password' && request.method === 'POST') { const data = await body(request); if (!strongPassword(data.password)) return fail(response, 400, 'A senha deve ter ao menos 8 caracteres, maiúscula, minúscula, número e símbolo.'); await run('UPDATE users SET password_hash=?, must_change_password=0 WHERE username=?', [hash(data.password), session.username]); session.mustChangePassword = 0; return json(response, 200, sessionData(session)); }
    if (session.mustChangePassword) return fail(response, 403, 'Troque a senha temporária para continuar.');
    if (pathname === '/api/users' && request.method === 'GET') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); return json(response, 200, await all('SELECT id, username, role, must_change_password FROM users ORDER BY username')); }
    if (pathname === '/api/users' && request.method === 'POST') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); const data = await body(request); const username = String(data.username || '').trim(); if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) return fail(response, 400, 'Usuário: 3 a 40 caracteres (letras, números, ponto, hífen ou sublinhado).'); try { await run('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)', [username, hash('123456'), 'user']); return json(response, 201, { username, temporaryPassword: '123456' }); } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ER_DUP_ENTRY') return fail(response, 409, 'Esse usuário já existe.'); console.error(error); return fail(response, 500, 'Não foi possível criar o usuário.'); } }
    const reset = pathname.match(/^\/api\/users\/(\d+)\/reset-password$/); if (reset && request.method === 'POST') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); const user = await one('SELECT username FROM users WHERE id=?', [Number(reset[1])]); if (!user) return fail(response, 404, 'Usuário não encontrado.'); await run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [hash('123456'), Number(reset[1])]); clearUserSessions(user.username); return json(response, 200, { temporaryPassword: '123456' }); }
    const removeUser = pathname.match(/^\/api\/users\/(\d+)$/); if (removeUser && request.method === 'DELETE') { if (session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.'); const user = await one('SELECT username, role FROM users WHERE id=?', [Number(removeUser[1])]); if (!user) return fail(response, 404, 'Usuário não encontrado.'); if (user.role === 'admin') return fail(response, 400, 'O administrador não pode ser removido.'); await run('DELETE FROM users WHERE id=?', [Number(removeUser[1])]); clearUserSessions(user.username); return json(response, 200, {}); }
    if (session.role === 'admin') return fail(response, 403, 'Administradores não acessam as guias.');
    if (pathname === '/api/dashboard' && request.method === 'GET') return json(response, 200, await dashboard());
    if (pathname === '/api/guides' && request.method === 'GET') return json(response, 200, await listGuides(url.searchParams.get('status')));
    if (pathname === '/api/guides' && request.method === 'POST') return json(response, 201, await save(await body(request)));
    if (pathname === '/api/options/ocs') return json(response, 200, (await all("SELECT DISTINCT ocs FROM guides WHERE trim(ocs)<>'' ORDER BY ocs")).map((row) => row.ocs));
    if (pathname === '/api/options/specifications') return json(response, 200, (await all('SELECT DISTINCT specification FROM guide_items WHERE module=? ORDER BY specification', [url.searchParams.get('module') || ''])).map((row) => row.specification));
    const match = pathname.match(/^\/api\/guides\/(\d+)(\/report)?$/); if (match) { const data = await guide(Number(match[1])); if (!data) return fail(response, 404, 'Guia não encontrada.'); if (match[2]) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return response.end(reportPage(data)); } if (request.method === 'GET') return json(response, 200, data); if (request.method === 'DELETE') { await transaction(async (connection) => { await run('DELETE FROM guide_items WHERE guide_number=?', [data.number], connection); await run('DELETE FROM guides WHERE number=?', [data.number], connection); }); return json(response, 200, {}); } }
    return fail(response, 404, 'Rota não encontrada.');
  } catch (error) { console.error(error); return fail(response, 400, error.message || 'Não foi possível concluir a operação.'); }
});

async function start() {
  await initializeDatabase();
  const admin = await one('SELECT id FROM users WHERE username=?', ['admin']);
  if (admin) await run("UPDATE users SET role='admin' WHERE id=?", [admin.id]);
  else await run('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)', ['admin', hash('Admin@123456'), 'admin']);
  server.listen(PORT, '127.0.0.1', () => console.log(`Guias PMGU moderno: http://localhost:${PORT}`));
}
start().catch((error) => { console.error('Não foi possível iniciar:', error.message); process.exitCode = 1; });
