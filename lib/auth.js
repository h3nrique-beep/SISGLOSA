const crypto = require('node:crypto');
const { one, all, run, isDuplicate } = require('./db');
const { cookie, clientAddress, httpError } = require('./http');
const { hashPassword, passwordMatches, strongPassword, temporaryPassword } = require('./passwords');

// Sessões: memória como cache e tabela sessions como fonte (reiniciar o serviço não desloga ninguém).
// Tentativas de login ficam só em memória: reiniciar zera os bloqueios.
const sessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 8) * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

const sessionData = (session) => ({ username: session.username, role: session.role, mustChangePassword: Boolean(session.mustChangePassword) });
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
    const row = await one('SELECT s.user_id, s.expires_at, u.username, u.role, u.must_change_password FROM sessions s JOIN users u ON u.id = s.user_id AND u.username = s.username WHERE s.token_hash=?', [tokenHash(id)]);
    if (row) { session = { userId: Number(row.user_id), username: row.username, role: row.role, mustChangePassword: row.must_change_password, expires: Number(row.expires_at) }; sessions.set(id, session); }
  }
  if (!session || session.expires <= Date.now()) { sessions.delete(id); if (session) await run('DELETE FROM sessions WHERE token_hash=?', [tokenHash(id)]); return null; }
  return session;
}

async function login(request, data) {
  const username = String(data.username || '').trim(); const key = loginKey(request, username);
  const attempts = recentAttempts(key); loginAttempts.set(key, attempts);
  if (attempts.length >= MAX_LOGIN_ATTEMPTS) throw httpError(429, 'Muitas tentativas. Aguarde 5 minutos para tentar novamente.');
  const saved = await one('SELECT id, username, password_hash, role, must_change_password FROM users WHERE username=?', [username]);
  if (!saved || !passwordMatches(String(data.password || ''), saved.password_hash)) { loginAttempts.set(key, [...attempts, Date.now()]); throw httpError(401, 'Usuário ou senha inválidos.'); }
  loginAttempts.delete(key); pruneSessions();
  const id = crypto.randomUUID();
  const session = { userId: Number(saved.id), username: saved.username, role: saved.role, mustChangePassword: saved.must_change_password, expires: Date.now() + SESSION_TTL_MS };
  sessions.set(id, session);
  await run('DELETE FROM sessions WHERE expires_at<=?', [Date.now()]);
  await run('INSERT INTO sessions (token_hash, user_id, username, expires_at) VALUES (?, ?, ?, ?)', [tokenHash(id), session.userId, session.username, session.expires]);
  return { id, session };
}
async function logout(request) { const id = cookie(request, 'PMGU_SESSION'); if (!id) return; sessions.delete(id); await run('DELETE FROM sessions WHERE token_hash=?', [tokenHash(id)]); }

async function changePassword(session, password) {
  if (!strongPassword(password)) throw httpError(400, 'A senha deve ter ao menos 8 caracteres, maiúscula, minúscula, número e símbolo.');
  await run('UPDATE users SET password_hash=?, must_change_password=0 WHERE username=?', [hashPassword(password), session.username]);
  session.mustChangePassword = 0;
}

const listUsers = () => all('SELECT id, username, role, must_change_password FROM users ORDER BY username');
async function createUser(data) {
  const username = String(data.username || '').trim(), role = String(data.role || 'user');
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw httpError(400, 'Usuário: 3 a 40 caracteres (letras, números, ponto, hífen ou sublinhado).');
  if (!['admin', 'user'].includes(role)) throw httpError(400, 'Perfil inválido.');
  const password = temporaryPassword();
  let id;
  try { id = Number((await run('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)', [username, hashPassword(password), role])).lastInsertRowid); } catch (error) {
    if (isDuplicate(error)) throw httpError(409, 'Esse usuário já existe.');
    throw error;
  }
  // Usuário novo começa do zero: o SQLite reaproveita o id de um usuário removido e o rascunho é guardado pelo nome,
  // então guias e rascunho de quem já teve esse id/nome não passam para ele (as guias continuam no banco).
  await run('UPDATE guides SET owner_id=NULL WHERE owner_id=?', [id]);
  await run('DELETE FROM sessions WHERE user_id=?', [id]);
  await run('DELETE FROM guide_drafts WHERE username=?', [username]);
  return { username, role, temporaryPassword: password };
}
async function resetPassword(id) {
  const user = await one('SELECT username FROM users WHERE id=?', [id]);
  if (!user) throw httpError(404, 'Usuário não encontrado.');
  const password = temporaryPassword();
  await run('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?', [hashPassword(password), id]);
  await clearUserSessions(user.username);
  return { temporaryPassword: password };
}
async function removeUser(id) {
  const user = await one('SELECT username, role FROM users WHERE id=?', [id]);
  if (!user) throw httpError(404, 'Usuário não encontrado.');
  if (user.role === 'admin') throw httpError(400, 'O administrador não pode ser removido.');
  await run('DELETE FROM users WHERE id=?', [id]);
  await clearUserSessions(user.username);
}
async function ensureAdmin() {
  const admin = await one('SELECT id FROM users WHERE username=?', ['admin']);
  if (admin) await run("UPDATE users SET role='admin' WHERE id=?", [admin.id]);
  else await run('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)', ['admin', hashPassword('Admin@123456'), 'admin']);
}

module.exports = { sessionData, sessionCookie, authenticated, login, logout, changePassword, listUsers, createUser, resetPassword, removeUser, ensureAdmin };
