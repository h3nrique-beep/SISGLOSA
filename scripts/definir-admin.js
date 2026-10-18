// Define a senha do administrador direto no banco SQLite (instalação inicial ou recuperação de senha).
// A senha vem da variável ADMIN_PASSWORD e nunca é gravada em arquivo nem aparece na saída.
// Uso: ADMIN_PASSWORD='nova-senha' node scripts/definir-admin.js [--usuario admin] [--remover-outros]
//   --remover-outros  apaga todas as outras contas (o painel passa a ter só o administrador)
// Com o serviço PARADO. Só para SQLite (o padrão); com MySQL (DB_HOST) o script se recusa.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, strongPassword } = require('../lib/passwords');

const fail = (message) => { console.error(`Erro: ${message}`); process.exit(1); };
const args = process.argv.slice(2);
const username = args.includes('--usuario') ? String(args[args.indexOf('--usuario') + 1] || '').trim() : 'admin';
const removeOthers = args.includes('--remover-outros');
const password = process.env.ADMIN_PASSWORD;

if (process.env.DB_HOST) fail('este script só trata o banco SQLite; com MySQL altere a senha pelo painel.');
if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) fail('usuário inválido (3 a 40 caracteres: letras, números, ponto, hífen ou sublinhado).');
if (!password) fail('defina a variável de ambiente ADMIN_PASSWORD.');
const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'guias.db');
if (!fs.existsSync(file)) fail(`banco não encontrado em ${file}. Inicie o sistema uma vez para criá-lo.`);

const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 5000');
try {
  db.exec('BEGIN');
  const existing = db.prepare('SELECT id FROM users WHERE username=?').get(username);
  const hash = hashPassword(password);
  if (existing) db.prepare("UPDATE users SET password_hash=?, role='admin', must_change_password=0 WHERE id=?").run(hash, existing.id);
  else db.prepare("INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, 'admin', 0)").run(username, hash);
  // Perfis múltiplos (users.roles): garante o de administrador sem tirar o de guias. Banco antigo sem a coluna: o sistema migra ao iniciar.
  if (db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name='roles'").get()) db.prepare("UPDATE users SET roles=CASE WHEN roles LIKE '%admin%' THEN roles WHEN roles='' THEN 'admin' ELSE roles || ',admin' END WHERE username=?").run(username);
  const removed = removeOthers ? Number(db.prepare('DELETE FROM users WHERE username<>?').run(username).changes) : 0;
  db.exec('COMMIT');
  console.log(`Senha do administrador "${username}" ${existing ? 'atualizada' : 'criada'}; troca obrigatória desligada.`);
  if (removeOthers) console.log(`Outras contas removidas: ${removed}.`);
  if (!strongPassword(password)) console.warn('Aviso: a senha não atende à política do sistema (8+ caracteres com maiúscula, minúscula, número e símbolo). Foi aplicada mesmo assim.');
} catch (error) { try { db.exec('ROLLBACK'); } catch {} fail(error.message); } finally { db.close(); }
