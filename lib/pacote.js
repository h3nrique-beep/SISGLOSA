const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Dono único das regras do pacote de atualização: o gerador (scripts/gerar-pacote.js)
// e o painel (lib/updates.js) usam estas regras, para nunca divergirem.
const MANIFEST_NAME = 'sisglosa-update.json';
// O pacote pode trazer qualquer arquivo destas pastas (inclusive arquivos novos). Ficam de fora,
// sempre: banco e cópias (data/), dependências instaladas (node_modules/), segredos (.env) e o .git.
const ALLOWED_ROOT_FILES = ['server.js', 'package.json', 'package-lock.json', 'README.md', 'PRODUCT.md'];
const ALLOWED_FOLDERS = ['lib/', 'public/', 'scripts/', 'deploy/'];
const MAX_FILES = 300;
function allowedFile(file) {
  const name = String(file || '');
  if (!name || name.length > 200 || /[\\:*?"<>|\x00]/.test(name) || name.startsWith('/')) return false;
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false;
  return ALLOWED_ROOT_FILES.includes(name) || ALLOWED_FOLDERS.some((folder) => name.startsWith(folder) && name.length > folder.length);
}
// Arquivo que o processo Node carrega: mudou, o serviço precisa reiniciar. Tela (public/), scripts e documentos não.
const needsRestart = (file) => file === 'server.js' || file.startsWith('lib/') || file === 'package.json' || file === 'package-lock.json';
// Mudou a lista de dependências: roda npm install antes de reiniciar.
const needsInstall = (file) => file === 'package.json' || file === 'package-lock.json';
const KINDS = ['corretiva', 'evolutiva'];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;
const MAX_MESSAGE = 500;

// Compara só x.y.z (ignora sufixo -beta/+build): >0 se a for maior que b.
function compareVersions(a, b) {
  const [x, y] = [a, b].map((value) => String(value).split(/[-+]/)[0].split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}

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

module.exports = { MANIFEST_NAME, MAX_FILES, allowedFile, needsRestart, needsInstall, KINDS, VERSION_PATTERN, MAX_MESSAGE, compareVersions, buildManifest, syntaxError };
