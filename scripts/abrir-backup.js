// Decifra um backup baixado pelo painel (.sgbk) de volta para um arquivo .db do SQLite.
// Uso: node scripts/abrir-backup.js guias-....db.sgbk saida.db   (a frase-senha é pedida no terminal)
const fs = require('node:fs');
const readline = require('node:readline');
const { decrypt } = require('../lib/backups');

const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('Uso: node scripts/abrir-backup.js <arquivo.sgbk> <saida.db>'); process.exit(1); }
if (fs.existsSync(output)) { console.error(`${output} já existe; escolha outro nome.`); process.exit(1); }
const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
prompt.question('Frase-senha do arquivo: ', (passphrase) => {
  prompt.close();
  try {
    fs.writeFileSync(output, decrypt(fs.readFileSync(input), passphrase), { mode: 0o600 });
    console.log(`Banco salvo em ${output}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
