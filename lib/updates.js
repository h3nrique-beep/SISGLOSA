const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { one, all, run, transaction, mysql, sqliteSnapshot } = require('./db');
const { httpError } = require('./http');
const pacote = require('./pacote');
const backups = require('./backups');
const monitor = require('./monitor');

const ROOT = path.join(__dirname, '..');
const MAX_UPDATE_SIZE = 25 * 1024 * 1024;
const APP_VERSION = require('../package.json').version;
const UPDATE_BACKUP_ROOT = process.env.UPDATE_BACKUP_ROOT || path.join(ROOT, 'data', 'updates', 'backups');
const updateError = (message) => httpError(400, message);

// Versão ativa = última aplicada por pacote (o package.json fica na versão da instalação).
const activeVersion = async () => (await one('SELECT setting_value FROM system_settings WHERE setting_key=?', ['app_version']))?.setting_value || APP_VERSION;
async function systemInfo() {
  return { version: await activeVersion(), updates: (await one('SELECT COUNT(*) AS total FROM update_packages')).total, database: mysql ? 'MySQL/MariaDB' : 'SQLite', node: process.version, uptime: Math.round(process.uptime()) };
}
const updateHistory = () => all('SELECT version, filename, applied_by, files, message, kind, backup, created_at FROM update_packages ORDER BY id DESC LIMIT 20');

// Cada pacote guarda cópia dos arquivos e do banco; mantém só as mais recentes para não encher o disco.
function pruneUpdateBackups(keep = 10) {
  try {
    const folders = fs.readdirSync(UPDATE_BACKUP_ROOT).filter((name) => /^\d+-[0-9a-f-]{36}$/.test(name)).sort().reverse();
    for (const name of folders.slice(keep)) fs.rmSync(path.join(UPDATE_BACKUP_ROOT, name), { recursive: true, force: true });
  } catch (error) { console.error('Não foi possível limpar cópias antigas de atualização:', error.message); }
}

// Dependências novas do package.json. shortcut: exige acesso ao registro do npm a partir do CT; sem rede, o pacote é recusado e desfeito.
function installDependencies() {
  try {
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'pipe', timeout: 5 * 60 * 1000, shell: process.platform === 'win32' });
  } catch (error) {
    const detail = String(error.stderr || error.message).split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || 'erro desconhecido';
    throw updateError(`Não foi possível instalar as dependências do pacote (${detail}); o pacote foi desfeito.`);
  }
}

function readPackage(buffer) {
  if (!buffer.length) throw updateError('Selecione um pacote ZIP.');
  let archive;
  try { archive = new AdmZip(buffer); } catch { throw updateError('O arquivo enviado não é um ZIP válido.'); }
  const entries = archive.getEntries().filter((entry) => !entry.isDirectory);
  if (!entries.length || entries.length > pacote.MAX_FILES + 1) throw updateError(`O pacote precisa ter de 1 a ${pacote.MAX_FILES} arquivos.`);
  const names = entries.map((entry) => entry.entryName.replaceAll('\\', '/'));
  if (new Set(names).size !== names.length) throw updateError('O pacote contém arquivos repetidos.');
  const blocked = names.filter((name) => name !== pacote.MANIFEST_NAME && !pacote.allowedFile(name));
  if (blocked.length) throw updateError(`O pacote contém arquivos não permitidos: ${blocked.slice(0, 5).join(', ')}. Permitidos: server.js, package.json, lib/, public/, scripts/ e deploy/.`);
  if (entries.reduce((total, entry) => total + Number(entry.header.size || 0), 0) > MAX_UPDATE_SIZE) throw updateError('O conteúdo descompactado excede o limite permitido.');
  return { entries, names };
}

async function applyUpdatePackage(buffer, filename, username, meta = {}) {
  const { entries, names } = readPackage(buffer);
  const manifestEntry = entries[names.indexOf(pacote.MANIFEST_NAME)];
  // Como no Sentinela: versão e descrição do manifesto (gerado pelo npm run pacote) valem sobre as do painel,
  // que só servem para pacote sem manifesto. O tipo é o escolhido no painel.
  let manifest = {};
  if (manifestEntry) { try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); } catch { throw updateError('O manifesto do pacote é inválido.'); } }
  const packed = names.filter((name) => name !== pacote.MANIFEST_NAME);
  const files = manifestEntry ? (Array.isArray(manifest.files) ? manifest.files : []) : packed;
  if ((manifestEntry && manifest.product !== 'SISGLOSA') || !files.length || new Set(files).size !== files.length || files.length !== packed.length || files.some((file) => !packed.includes(file))) throw updateError('O manifesto não corresponde aos arquivos do pacote.');
  // Descrição só com pontuação (ex.: ".") conta como vazia.
  const panelMessage = /[\p{L}\p{N}]/u.test(String(meta.message || '')) ? String(meta.message).trim() : '';
  const version = String(manifest.version || meta.version || '').trim(), message = String(manifest.message || panelMessage).trim(), type = String(meta.type || manifest.type || 'corretiva');
  if (!message || message.length > pacote.MAX_MESSAGE) throw updateError(`Descreva o que mudou nesta atualização, com até ${pacote.MAX_MESSAGE} caracteres.`);
  if (!pacote.KINDS.includes(type)) throw updateError(`Tipo de atualização inválido. Use: ${pacote.KINDS.join(', ')}.`);
  if (!pacote.VERSION_PATTERN.test(version)) throw updateError('Informe a próxima versão no formato x.y.z (ex.: 2.0.1).');
  // Versão menor que a ativa é permitida: é a reversão (aplicar o pacote de uma versão anterior).
  const reverted = pacote.compareVersions(version, (await systemInfo()).version) < 0;
  const contents = new Map(files.map((file) => [file, entries[names.indexOf(file)].getData()]));
  for (const [file, content] of contents) { const problem = pacote.syntaxError(file, content); if (problem) throw updateError(`O arquivo ${file} tem erro de sintaxe (${problem}); o pacote não foi aplicado.`); }
  if (contents.has('package.json')) { try { JSON.parse(contents.get('package.json').toString('utf8')); } catch { throw updateError('O package.json do pacote é inválido.'); } }

  const backupRoot = path.join(UPDATE_BACKUP_ROOT, `${Date.now()}-${crypto.randomUUID()}`);
  const replaced = [], created = [];
  const rollback = () => {
    for (const file of replaced) fs.copyFileSync(path.join(backupRoot, file), path.join(ROOT, file));
    for (const file of created) fs.rmSync(path.join(ROOT, file), { force: true });
  };
  try {
    fs.mkdirSync(backupRoot, { recursive: true });
    // Cópia do banco antes de o código novo (que pode migrar tabelas ao reiniciar) rodar.
    sqliteSnapshot(path.join(backupRoot, 'guias.db'));
    if (backups.enabled()) backups.create('pre-update', username);
    for (const [file, content] of contents) {
      const target = path.join(ROOT, file);
      if (fs.existsSync(target)) {
        const backup = path.join(backupRoot, file); fs.mkdirSync(path.dirname(backup), { recursive: true }); fs.copyFileSync(target, backup); replaced.push(file);
      } else { fs.mkdirSync(path.dirname(target), { recursive: true }); created.push(file); }
      fs.writeFileSync(target, content);
    }
    if (files.some(pacote.needsInstall)) installDependencies();
    await transaction(async (connection) => {
      await run('INSERT INTO update_packages (version, filename, applied_by, files, message, kind, backup) VALUES (?, ?, ?, ?, ?, ?, ?)', [version, filename, username, JSON.stringify(files), message, type, backupRoot], connection);
      await run('UPDATE system_settings SET setting_value=? WHERE setting_key=?', [version, 'app_version'], connection);
    });
  } catch (error) {
    rollback();
    throw error;
  }
  pruneUpdateBackups();
  // Código novo aplicado pelo painel: vira a nova referência do monitor de integridade.
  monitor.snapshotFiles(username);
  return { version, reverted, type, message, files, created, backup: backupRoot, restartRequired: files.some(pacote.needsRestart) };
}

module.exports = { MAX_UPDATE_SIZE, activeVersion, systemInfo, updateHistory, applyUpdatePackage };
