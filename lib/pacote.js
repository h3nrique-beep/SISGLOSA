const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Dono único das regras do pacote de atualização: o gerador (scripts/gerar-pacote.js)
// e o painel (server.js) leem esta lista, para nunca divergirem.
const MANIFEST_NAME = 'sisglosa-update.json';
const UPDATE_FILES = ['server.js', 'lib/passwords.js', 'lib/pacote.js', 'public/index.html', 'public/app.js', 'public/styles.css'];
// Mudou um destes: o processo Node precisa reiniciar para carregar o código novo.
const RESTART_FILES = ['server.js', 'lib/passwords.js', 'lib/pacote.js'];
const KINDS = ['corretiva', 'evolutiva', 'seguranca'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const MAX_MESSAGE = 500;

function buildManifest({ version, message, type = 'corretiva', files }) {
  return { product: 'SISGLOSA', version, type, message, files };
}

// Erro de sintaxe num arquivo JS derrubaria o sistema no próximo reinício: recusa antes de aplicar.
function syntaxError(file, content) {
  if (!file.endsWith('.js')) return null;
  const temp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sisglosa-syntax-')), path.basename(file));
  try {
    fs.writeFileSync(temp, content);
    execFileSync(process.execPath, ['--check', temp], { stdio: 'pipe' });
    return null;
  } catch (error) {
    return String(error.stderr || error.message).split('\n').find((line) => /Error/.test(line)) || 'erro de sintaxe';
  } finally { fs.rmSync(path.dirname(temp), { recursive: true, force: true }); }
}

module.exports = { MANIFEST_NAME, UPDATE_FILES, RESTART_FILES, KINDS, VERSION_PATTERN, MAX_MESSAGE, buildManifest, syntaxError };
