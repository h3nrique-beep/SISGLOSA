const crypto = require('node:crypto');

const PASSWORD_ITERATIONS = 120000;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const digest = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, 32, 'sha256').toString('base64');
  return `${salt.toString('base64')}:${digest}`;
}

function passwordMatches(password, saved) {
  const [salt, value] = String(saved || '').split(':');
  if (!salt || !value) return false;
  const expected = Buffer.from(value, 'base64');
  const actual = crypto.pbkdf2Sync(password, Buffer.from(salt, 'base64'), PASSWORD_ITERATIONS, 32, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function strongPassword(password) {
  return typeof password === 'string'
    && password.length >= 8
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^A-Za-z0-9]/.test(password);
}

function temporaryPassword() {
  return `Pmgu!${crypto.randomBytes(9).toString('base64url')}`;
}

module.exports = { hashPassword, passwordMatches, strongPassword, temporaryPassword };
