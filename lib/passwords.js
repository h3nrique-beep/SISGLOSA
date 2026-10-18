const crypto = require('node:crypto');

// Recomendação OWASP para PBKDF2-SHA256. Hash novo: "iterações:salt:digest"; o antigo "salt:digest" usava 120.000
// e é refeito no próximo login (needsRehash).
const PASSWORD_ITERATIONS = 600000;
const LEGACY_ITERATIONS = 120000;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const digest = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('base64');
  return `${PASSWORD_ITERATIONS}:${salt.toString('base64')}:${digest}`;
}

function passwordMatches(password, saved) {
  const parts = String(saved || '').split(':');
  const [iterations, salt, value] = parts.length === 3 ? [Number(parts[0]), parts[1], parts[2]] : [LEGACY_ITERATIONS, ...parts];
  if (!salt || !value || !Number.isSafeInteger(iterations) || iterations < 1) return false;
  const expected = Buffer.from(value, 'base64');
  const actual = crypto.pbkdf2Sync(String(password), Buffer.from(salt, 'base64'), iterations, 32, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}
const needsRehash = (saved) => !String(saved || '').startsWith(`${PASSWORD_ITERATIONS}:`);
// Login com usuário inexistente gasta o mesmo tempo que um real: a demora não revela quais nomes existem.
let dummyHash = null;
function wasteTime(password) { dummyHash ||= hashPassword('usuario-inexistente'); passwordMatches(password, dummyHash); }

function strongPassword(password) {
  return typeof password === 'string'
    && password.length >= 8
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

// Senha padrão do primeiro acesso (pedido da administração); o login obriga a troca por uma senha forte.
const INITIAL_PASSWORD = '123456';
function temporaryPassword() {
  return INITIAL_PASSWORD;
}

module.exports = { hashPassword, passwordMatches, needsRehash, wasteTime, strongPassword, temporaryPassword };
