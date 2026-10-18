const http = require('node:http');
const path = require('node:path');
const { one, run, initializeDatabase } = require('./lib/db');
const { json, fail, html, serve, body, rawBody, httpError, clientAddress, securityHeaders } = require('./lib/http');
const auth = require('./lib/auth');
const guides = require('./lib/guides');
const options = require('./lib/options');
const updates = require('./lib/updates');
const backups = require('./lib/backups');
const monitor = require('./lib/monitor');
const { reportPage } = require('./lib/report');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
// Sem Nginx na frente (instalação offline), HOST=0.0.0.0 expõe a aplicação direto na rede.
const HOST = process.env.HOST || '127.0.0.1';
const APP_VERSION = require('./package.json').version;

const STATIC = {
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['public/app.js', 'application/javascript; charset=utf-8'],
  '/template-logo.png': ['public/template-logo.png', 'image/png'],
  '/sisglosa.jpg': ['public/sisglosa.jpg', 'image/jpeg'],
  '/bootstrap-icons.css': ['node_modules/bootstrap-icons/font/bootstrap-icons.css', 'text/css; charset=utf-8'],
  '/fonts/bootstrap-icons.woff2': ['node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff2', 'font/woff2'],
  '/fonts/bootstrap-icons.woff': ['node_modules/bootstrap-icons/font/fonts/bootstrap-icons.woff', 'font/woff'],
};
const PAGES = ['/', '/login', '/guias', '/registros', '/administracao', '/desenvolvedor', '/index.html'];

// Rotas da API: [método, caminho (texto ou expressão), acesso, ação].
// Acesso: 'public' sem login; 'session' qualquer usuário logado (mesmo com senha temporária);
// 'admin' só administrador; 'user' só quem registra guias (administrador não acessa as guias).
// Todo usuário vê a versão ativa no cabeçalho, não só o administrador.
const sessionData = async (session) => ({ ...auth.sessionData(session), version: await updates.activeVersion() });
const query = (ctx) => Object.fromEntries(ctx.url.searchParams);
const routes = [
  ['GET', '/health', 'public', async () => { await one('SELECT 1'); return { status: 'ok' }; }],
  ['POST', '/api/login', 'public', async (ctx) => {
    const { id, session } = await auth.login(ctx.request, await body(ctx.request));
    return ctx.reply(200, await sessionData(session), { 'Set-Cookie': auth.sessionCookie(id) });
  }],
  ['POST', '/api/logout', 'public', async (ctx) => { await auth.logout(ctx.request); return ctx.reply(200, {}, { 'Set-Cookie': auth.sessionCookie('', 0) }); }],
  ['GET', '/api/session', 'session', (ctx) => sessionData(ctx.session)],
  ['POST', '/api/session/role', 'session', async (ctx) => { await auth.switchRole(ctx.request, ctx.session, String((await body(ctx.request)).role || '')); return sessionData(ctx.session); }],
  ['POST', '/api/password', 'session', async (ctx) => { await auth.changePassword(ctx.session, (await body(ctx.request)).password); return sessionData(ctx.session); }],

  ['GET', '/api/users', 'admin', () => auth.listUsers()],
  ['POST', '/api/users', 'admin', async (ctx) => ctx.reply(201, await auth.createUser(await body(ctx.request)))],
  ['POST', /^\/api\/users\/(\d+)\/reset-password$/, 'admin', (ctx) => auth.resetPassword(Number(ctx.params[1]))],
  ['PUT', /^\/api\/users\/(\d+)\/roles$/, 'admin', async (ctx) => auth.setRoles(ctx.session, Number(ctx.params[1]), await body(ctx.request))],
  ['DELETE', /^\/api\/users\/(\d+)$/, 'admin', async (ctx) => { await auth.removeUser(Number(ctx.params[1])); return {}; }],
  ['GET', '/api/admin/system', 'admin', () => updates.systemInfo()],
  ['GET', '/api/admin/updates', 'admin', () => updates.updateHistory()],
  ['POST', '/api/admin/updates', 'admin', async (ctx) => {
    const { request, response } = ctx;
    if (!/^application\/(zip|octet-stream)(?:;|$)/.test(request.headers['content-type'] || '')) return ctx.reply(415, { error: 'Envie um arquivo ZIP.' });
    const header = (name) => { try { return decodeURIComponent(String(request.headers[name] || '')); } catch { return ''; } };
    const filename = (header('x-update-filename') || 'atualizacao.zip').replace(/[^A-Za-z0-9._-]/g, '_');
    if (!filename.toLowerCase().endsWith('.zip')) return ctx.reply(400, { error: 'O pacote precisa ter extensão .zip.' });
    const result = await updates.applyUpdatePackage(await rawBody(request, updates.MAX_UPDATE_SIZE), filename, ctx.session.username, { version: header('x-update-version'), type: header('x-update-type'), message: header('x-update-message') });
    // Sob o systemd (INVOCATION_ID), sai após responder e o Restart=always carrega o código novo, sem acesso por SSH.
    if (result.restartRequired && process.env.INVOCATION_ID) { result.autoRestart = true; response.on('finish', () => setTimeout(() => process.exit(0), 500)); }
    return ctx.reply(201, result);
  }],
  ['GET', '/api/admin/monitor', 'admin', () => monitor.status()],
  ['POST', '/api/admin/monitor/check', 'admin', async () => { await monitor.checkIntegrity(); return monitor.status(); }],
  ['POST', '/api/admin/monitor/accept', 'admin', async (ctx) => { await auth.confirmPassword(ctx.session, (await body(ctx.request)).password); await monitor.acceptFiles(ctx.session.username); return monitor.status(); }],
  ['GET', '/api/admin/backups', 'admin', () => ({ enabled: backups.enabled(), backups: backups.list(), history: backups.history() })],
  ['POST', '/api/admin/backups', 'admin', async (ctx) => { const result = backups.create('manual', ctx.session.username); await monitor.checkIntegrity(); return ctx.reply(201, result); }],
  // Baixar e restaurar pedem a senha de novo; o arquivo baixado sai cifrado com a frase-senha informada.
  ['POST', '/api/admin/backups/download', 'admin', async (ctx) => {
    const data = await body(ctx.request); await auth.confirmPassword(ctx.session, data.password);
    const file = backups.download(data.name, data.passphrase, ctx.session.username, clientAddress(ctx.request));
    ctx.response.writeHead(200, { ...securityHeaders, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${data.name}.sgbk"`, 'Cache-Control': 'no-store' }).end(file);
  }],
  ['POST', '/api/admin/backups/restore', 'admin', async (ctx) => {
    const data = await body(ctx.request);
    if (data.confirmation !== 'RESTAURAR') throw httpError(400, 'Digite RESTAURAR para confirmar.');
    await auth.confirmPassword(ctx.session, data.password);
    // O banco restaurado volta com a versão antiga gravada; a versão ativa é a do código que está rodando.
    const version = await updates.activeVersion();
    const result = await backups.restore(data.name, ctx.session.username, clientAddress(ctx.request), APP_VERSION);
    await run('UPDATE system_settings SET setting_value=? WHERE setting_key=?', [version, 'app_version']);
    await auth.clearAllSessions(); options.invalidate(); await monitor.checkIntegrity();
    return ctx.reply(200, result, { 'Set-Cookie': auth.sessionCookie('', 0) });
  }],

  // Guias e sugestões são sempre do usuário logado (ctx.session.userId).
  ['GET', '/api/dashboard', 'user', (ctx) => guides.dashboard(ctx.session.userId)],
  ['GET', '/api/guides', 'user', (ctx) => guides.listGuides(ctx.session.userId, query(ctx))],
  ['POST', '/api/guides', 'user', async (ctx) => ctx.reply(201, await guides.save({ ...(await body(ctx.request)), username: ctx.session.username, owner: ctx.session.userId }))],
  ['GET', '/api/guides/attendance', 'user', (ctx) => guides.sameAttendance(ctx.url.searchParams.get('number'), ctx.url.searchParams.get('exclude'), ctx.session.userId)],
  ['GET', '/api/draft', 'user', (ctx) => guides.draft(ctx.session.username)],
  ['PUT', '/api/draft', 'user', async (ctx) => { await guides.saveDraft(ctx.session.username, await body(ctx.request)); return {}; }],
  ['DELETE', '/api/draft', 'user', async (ctx) => { await guides.deleteDraft(ctx.session.username); return {}; }],
  ['GET', /^\/api\/guides\/(\d+)\/history$/, 'user', (ctx) => guides.history(Number(ctx.params[1]), ctx.session.userId)],
  ['GET', /^\/api\/guides\/(\d+)\/report$/, 'user', async (ctx) => {
    const data = await guides.guide(Number(ctx.params[1]), ctx.session.userId);
    if (!data) return ctx.reply(404, { error: 'Guia não encontrada.' });
    html(ctx.response, reportPage(data));
  }],
  ['GET', /^\/api\/guides\/(\d+)$/, 'user', async (ctx) => (await guides.guide(Number(ctx.params[1]), ctx.session.userId)) || ctx.reply(404, { error: 'Guia não encontrada.' })],
  ['DELETE', /^\/api\/guides\/(\d+)$/, 'user', async (ctx) => { await guides.remove(Number(ctx.params[1]), ctx.session.userId); return {}; }],

  ['GET', '/api/options/ocs', 'user', (ctx) => options.ocs(ctx.session.userId)],
  ['GET', '/api/options/patients', 'user', (ctx) => options.patients(ctx.session.userId)],
  ['GET', '/api/options/specifications', 'user', (ctx) => options.specifications(ctx.session.userId, ctx.url.searchParams.get('module'))],
  ['DELETE', /^\/api\/options\/(ocs|patients|specifications)$/, 'user', async (ctx) => { await options.hideSuggestion(ctx.params[1], (await body(ctx.request)).value); return {}; }],
  ['GET', '/api/options/modules', 'user', (ctx) => options.modules(ctx.session.userId)],
  ['GET', '/api/options/justifications', 'user', (ctx) => options.justifications(ctx.session.userId)],
  ['POST', '/api/options/justifications', 'user', async (ctx) => ctx.reply(201, await options.saveJustification((await body(ctx.request)).justification))],
  ['DELETE', '/api/options/justifications', 'user', async (ctx) => { await options.deleteJustification((await body(ctx.request)).justification); return {}; }],
];

function matchRoute(method, pathname) {
  for (const [routeMethod, pattern, access, handler] of routes) {
    const params = typeof pattern === 'string' ? (pattern === pathname ? [pathname] : null) : pathname.match(pattern);
    if (params && routeMethod === method) return { access, handler, params };
  }
  return null;
}

const server = http.createServer(async (request, response) => {
  response.on('finish', () => monitor.request(response.statusCode));
  try {
    const url = new URL(request.url, 'http://localhost'); const pathname = url.pathname;
    if (STATIC[pathname]) return serve(response, path.join(ROOT, STATIC[pathname][0]), STATIC[pathname][1]);
    if (PAGES.includes(pathname)) return serve(response, path.join(ROOT, 'public', 'index.html'), 'text/html; charset=utf-8');
    const route = matchRoute(request.method, pathname);
    let session = null;
    if (route?.access !== 'public') {
      session = await auth.authenticated(request);
      if (!session) return fail(response, 401, 'Sessão expirada.');
      if (route?.access !== 'session' && session.mustChangePassword) return fail(response, 403, 'Troque a senha temporária para continuar.');
      if (route?.access === 'admin' && session.role !== 'admin') return fail(response, 403, 'Acesso exclusivo do administrador.');
      if (route?.access === 'user' && session.role === 'admin') return fail(response, 403, 'Administradores não acessam as guias.');
    }
    if (!route) return fail(response, 404, 'Rota não encontrada.');
    let replied = false;
    const reply = (status, value, headers) => { replied = true; json(response, status, value, headers); };
    const result = await route.handler({ request, response, url, params: route.params, session, reply });
    if (!replied && !response.headersSent) json(response, 200, result === undefined ? {} : result);
  } catch (error) {
    if (!error.statusCode) console.error(error);
    if (!response.headersSent) fail(response, error.statusCode || 400, error.message || 'Não foi possível concluir a operação.');
  }
});

async function start() {
  await initializeDatabase(APP_VERSION);
  await auth.ensureAdmin();
  backups.startSchedule();
  monitor.start();
  server.listen(PORT, HOST, () => console.log(`SISGLOSA: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}
start().catch((error) => { console.error('Não foi possível iniciar:', error.message); process.exitCode = 1; });
