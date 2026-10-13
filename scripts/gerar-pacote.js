// Gera o pacote .zip de atualização que o painel (Administração › Atualizações) aplica.
// Uso: npm run pacote -- --versao 2.0.1 --mensagem "O que mudou" [--tipo corretiva|evolutiva|seguranca]
//        [--arquivos public/app.js,public/styles.css] [--desde <ref-git>] [--saida <pasta>] [--forcar]
const AdmZip = require('adm-zip');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const pacote = require('../lib/pacote');

const ROOT = path.join(__dirname, '..');
const fail = (message) => { console.error(`Erro: ${message}`); process.exit(1); };

const options = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (!args[i].startsWith('--')) fail(`argumento inesperado "${args[i]}".`);
  const name = args[i].slice(2);
  options[name] = name === 'forcar' ? true : args[++i];
}

const version = String(options.versao || '').trim();
if (!pacote.VERSION_PATTERN.test(version)) fail('informe --versao no formato x.y.z (ex.: 2.0.1).');
const message = String(options.mensagem || '').trim();
if (!message || message.length > pacote.MAX_MESSAGE) fail(`informe --mensagem (até ${pacote.MAX_MESSAGE} caracteres): é o texto que o administrador lê no histórico.`);
const type = String(options.tipo || 'corretiva');
if (!pacote.KINDS.includes(type)) fail(`--tipo deve ser um destes: ${pacote.KINDS.join(', ')}.`);

// Padrão: todos os arquivos permitidos. --arquivos escolhe a dedo; --desde pega só o que mudou desde um commit/tag.
let files = pacote.UPDATE_FILES;
if (options.arquivos) files = options.arquivos.split(',').map((file) => file.trim().replaceAll('\\', '/')).filter(Boolean);
else if (options.desde) {
  let changed;
  try { changed = execFileSync('git', ['diff', '--name-only', String(options.desde)], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').map((line) => line.trim()).filter(Boolean); }
  catch { fail(`não consegui comparar com "${options.desde}" (git instalado? referência existe?).`); }
  files = pacote.UPDATE_FILES.filter((file) => changed.includes(file));
  if (!files.length) fail(`nenhum arquivo atualizável mudou desde ${options.desde}.`);
}
const invalid = files.filter((file) => !pacote.UPDATE_FILES.includes(file));
if (invalid.length) fail(`arquivo(s) fora da lista permitida: ${invalid.join(', ')}. Permitidos: ${pacote.UPDATE_FILES.join(', ')}.`);
if (new Set(files).size !== files.length) fail('há arquivos repetidos em --arquivos.');

const zip = new AdmZip();
zip.addFile(pacote.MANIFEST_NAME, Buffer.from(`${JSON.stringify(pacote.buildManifest({ version, message, type, files }), null, 2)}\n`));
for (const file of files) {
  const source = path.join(ROOT, file);
  if (!fs.existsSync(source)) fail(`arquivo não encontrado: ${file}.`);
  const content = fs.readFileSync(source);
  const problem = pacote.syntaxError(file, content);
  if (problem) fail(`${file} tem erro de sintaxe (${problem}); corrija antes de gerar o pacote.`);
  zip.addFile(file, content);
}

const outputDir = path.resolve(ROOT, options.saida || path.join('output', 'pacotes'));
fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, `sisglosa-${version}.zip`);
if (fs.existsSync(output) && !options.forcar) fail(`${output} já existe. Use --forcar para gerar de novo.`);
const buffer = zip.toBuffer();
fs.writeFileSync(output, buffer);

console.log(`Pacote ${version} (${type}) gerado: ${output}`);
console.log(`Arquivos: ${files.join(', ')}`);
console.log(`Tamanho: ${(buffer.length / 1024).toFixed(1)} KB · sha256 ${crypto.createHash('sha256').update(buffer).digest('hex')}`);
console.log(files.some((file) => pacote.RESTART_FILES.includes(file)) ? 'Após aplicar, reinicie o serviço: systemctl restart sisglosa' : 'Após aplicar, basta recarregar a página.');
