const crypto = require('node:crypto');
const { one, all, run, isDuplicate } = require('./db');
const { cookie, clientAddress, httpError } = require('./http');
const { hashPassword, passwordMatches, needsRehash, wasteTime, strongPassword, temporaryPassword } = require('./passwords');
const monitor = require('./monitor');

// Sessões: memória como cache e tabela sessions como fonte (reiniciar o serviço não desloga ninguém).
// Tentativas de login ficam só em memória: reiniciar zera os bloqueios.
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

const ROLES = ['user', 'admin'];
// Perfis do usuário: users.roles (lista separada por vírgula); users.role é o perfil inicial ao entrar.
const rolesOf = (user) => String(user.roles || user.role).split(',').filter((role) => ROLES.includes(role));
const sessionData = (session) => ({ username: session.username, role: session.role, roles: session.roles, mustChangePassword: Boolean(session.mustChangePassword) });
const tokenHash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');
async function clearUserSessions(username) { for (const [id, session] of sessions) if (session.username === username) sessions.delete(id); await run('DELETE FROM sessions WHERE username=?', [username]); }
function pruneSessions() { for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id); }
const loginKey = (request, username) => `${clientAddress(request)}:${username.toLowerCase()}`;
const recentAttempts = (key) => (loginAttempts.get(key) || []).filter((time) => time > Date.now() - LOGIN_WINDOW_MS);
const sessionCookie = (id, maxAge = null) => `PMGU_SESSION=${id}; ${maxAge === null ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ` : 'Max-Age=0; '}HttpOnly; SameSite=Strict; Path=/${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`;

async function authenticated(request) {
  const id = cookie(request, 'PMGU_SESSION'); if (!id) return null;
  let session = sessions.get(id);
  if (!session) {
    // Depois de um reinício: recarrega do banco. Confere id e nome, para um usuário recriado não herdar a sessão de outro.
    const row = await one('SELECT s.user_id, s.expires_at, s.role AS active_role, u.username, u.role, u.roles, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id AND u.username = s.username WHERE s.token_hash=?', [tokenHash(id)]);
    if (row) { const roles = rolesOf(row); session = { userId: Number(row.user_id), username: row.username, roles, role: roles.includes(row.active_role) ? row.active_role : row.role, mustChangePassword: row.must_change_password, expires: Number(row.expires_at) }; sessions.set(id, session); }
  }
  if (!session || session.expires <= Date.now()) { sessions.delete(id); if (session) await run('DELETE FROM sessions WHERE token_hash=?', [tokenHash(id)]); return null; }
  return session;
}

async function login(request, data) {
  const username = String(data.username || '').trim(); const key = loginKey(request, username);
  const attempts = recentAttempts(key); loginAttempts.set(key, attempts);
  if (attempts.length >= MAX_LOGIN_ATTEMPTS) throw httpError(429, 'Muitas tentativas. Aguarde 5 minutos para tentar novamente.');
  const saved = await one('SELECT id, username, password_hash, role, roles, must_change_password FROM users WHERE username=?', [username]);
  const password = String(data.password || '');
  if (!saved) wasteTime(password);
  if (!saved || !passwordMatches(password, saved.password_hash)) { loginAttempts.set(key, [...attempts, Date.now()]); monitor.loginFailed(clientAddress(request)); throw httpError(401, 'Usuário ou senha inválidos.'); }
  if (needsRehash(saved.password_hash)) await run('UPDATE users SET password_hash=? WHERE id=?', [hashPassword(password), saved.id]);
  loginAttempts.delete(key); pruneSessions();
  const id = crypto.randomUUID();
  const session = { userId: Number(saved.id), username: saved.username, role: saved.role, roles: rolesOf(saved), mustChangePassword: saved.must_change_password, expires: Date.now() + SESSION_TTL_MS };
  sessions.set(id, session);
  await run('DELETE FROM sessions WHERE expires_at<=?', [Date.now()]);
  await run('INSERT INTO sessions (token_hash, user_id, username, expires_at, role) VALUES (?, ?, ?, ?, ?)', [tokenHash(id), session.userId, session.username, session.expires, session.role]);
  return { id, session };
}
// Troca o perfil ativo da sessão, só entre os perfis que o admin deu ao usuário.
async function switchRole(request, session, role) {
  if (!session.roles.includes(role)) throw httpError(403, 'Perfil não disponível para este usuário.');
  session.role = role;
  await run('UPDATE sessions SET role=? WHERE token_hash=?', [role, tokenHash(cookie(request, 'PMGU_SESSION'))]);
}
function parseRoles(data) {
  const asked = [].concat(data.roles ?? data.role ?? 'user').map(String);
  if (!asked.length || asked.some((role) => !ROLES.includes(role))) throw httpError(400, 'Perfil inválido.');
  return ROLES.filter((role) => asked.includes(role));
}
// Ações sensíveis do painel (baixar/restaurar backup, aceitar integridade) pedem a senha de novo.
async function confirmPassword(session, password) {
  const saved = await one('SELECT password_hash FROM users WHERE id=? AND username=?', [session.userId, session.username]);
  if (!saved || !passwordMatches(String(password || ''), saved.password_hash)) throw httpError(403, 'Senha incorreta.');
}
// Depois de restaurar o banco: todos saem (as sessões do banco antigo não valem mais).
async function clearAllSessions() { sessions.clear(); await run('DELETE FROM sessions'); }
async function logout(request) { const id = cookie(request, 'PMGU_SESSION'); if (!id) return; sessions.delete(id); await run('DELETE FROM sessions WHERE token_hash=?', [tokenHash(id)]); }

async function changePassword(session, password) {
  if (!strongPassword(password)) throw httpError(400, 'A senha deve ter ao menos 8 caracteres, maiúscula, minúscula, número e símbolo.');
  await run('UPDATE users SET password_hash=?, must_change_password=0 WHERE username=?', [hashPassword(password), session.username]);
  session.mustChangePassword = 0;
}

const listUsers = async () => (await all('SELECT id, username, role, roles, must_change_password FROM users ORDER BY username')).map((user) => ({ ...user, roles: rolesOf(user) }));
async function createUser(data) {
  const username = String(data.username || '').trim(), roles = parseRoles(data), role = roles[0];
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw httpError(400, 'Usuário: 3 a 40 caracteres (letras, números, ponto, hífen ou sublinhado).');
  const password = temporaryPassword();
  let id;
  try { id = Number((await run('INSERT INTO users (username, password_hash, role, roles, must_change_password) VALUES (?, ?, ?, ?, 1)', [username, hashPassword(password), role, roles.join(',')])).lastInsertRowid); } catch (error) {
    if (isDuplicate(error)) throw httpError(409, 'Esse usuário já existe.');
    throw error;
  }
  // Usuário novo começa do zero: o SQLite reaproveita o id de um usuário removido e o rascunho é guardado pelo nome,
  // então guias e rascunho de quem já teve esse id/nome não passam para ele (as guias continuam no banco).
  await run('UPDATE guides SET owner_id=NULL WHERE owner_id=?', [id]);
  for (const table of ['saved_justifications', 'deleted_justifications', 'hidden_suggestions']) await run(`DELETE FROM ${table} WHERE owner_id=?`, [id]);
  await run('DELETE FROM sessions WHERE user_id=?', [id]);
  await run('DELETE FROM guide_drafts WHERE username=?', [username]);
  return { username, role, roles, temporaryPassword: password };
}
async function resetPassword(id) {
  const user = await one('SELECT username FROM users WHERE id=?', [id]);
  if (!user) throw httpError(404, 'Usuário não encontrado.');
  const password = temporaryPassword();
  await run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [hashPassword(password), id]);
  await clearUserSessions(user.username);
  return { username: user.username, temporaryPassword: password };
}
// Outro usuário com perfis alterados é deslogado: a sessão aberta não pode manter um perfil retirado.
async function setRoles(session, id, data) {
  const user = await one('SELECT username, role FROM users WHERE id=?', [id]);
  if (!user) throw httpError(404, 'Usuário não encontrado.');
  const roles = parseRoles(data);
  if ((user.username === 'admin' || id === session.userId) && !roles.includes('admin')) throw httpError(400, 'Este usuário não pode perder o perfil de administrador.');
  await run('UPDATE users SET role=?, roles=? WHERE id=?', [roles.includes(user.role) ? user.role : roles[0], roles.join(','), id]);
  if (id === session.userId) session.roles = roles;
  else await clearUserSessions(user.username);
  return { username: user.username, roles };
}
async function removeUser(id) {
  const user = await one('SELECT username, role, roles FROM users WHERE id=?', [id]);
  if (!user) throw httpError(404, 'Usuário não encontrado.');
  if (rolesOf(user).includes('admin')) throw httpError(400, 'O administrador não pode ser removido.');
  await run('DELETE FROM users WHERE id=?', [id]);
  await clearUserSessions(user.username);
  return { username: user.username };
}
async function ensureAdmin() {
  const admin = await one('SELECT id, role, roles FROM users WHERE username=?', ['admin']);
  if (admin) await run('UPDATE users SET roles=? WHERE id=?', [ROLES.filter((role) => role === 'admin' || rolesOf(admin).includes(role)).join(','), admin.id]);
  else await run('INSERT INTO users (username, password_hash, role, roles, must_change_password) VALUES (?, ?, ?, ?, 1)', ['admin', hashPassword('Admin@123456'), 'admin', 'admin']);
}

module.exports = { switchRole, setRoles, confirmPassword, clearAllSessions, sessionData, sessionCookie, authenticated, login, logout, changePassword, listUsers, createUser, resetPassword, removeUser, ensureAdmin };
