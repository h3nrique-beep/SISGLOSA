# Implantação no Proxmox VE 8.3

O SISGLOSA é uma aplicação **Node.js 22** (não Java). Use uma VM Debian 12 ou um contêiner LXC **não privilegiado** com Debian 12 no Proxmox VE 8.3.0; os passos dentro da máquina são os mesmos. Para esta aplicação, 2 vCPU, 2 GB de RAM e 16 GB de disco são suficientes. Marque **Start at boot**, mantenha o firewall do Proxmox ativo e libere somente a porta 80 (e 443 quando o HTTPS estiver configurado). Em VM, ative a opção **QEMU Guest Agent** e instale `qemu-guest-agent`. Não é necessário habilitar *nesting*.

## 1. Dependências

Instale Node.js 22 (versão 22.13 ou superior), Nginx, Git e SQLite. Confirme `node --version` antes de continuar.

```bash
apt update
apt install -y ca-certificates curl gnupg nginx git sqlite3 qemu-guest-agent
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version
timedatectl set-timezone America/Sao_Paulo
```

## 2. Aplicação

O banco padrão é SQLite (`data/guias.db`) e não exige configuração. Os arquivos precisam pertencer ao usuário `sisglosa`, porque o painel de administração substitui arquivos do sistema ao aplicar um pacote `.zip`.

```bash
adduser --system --group --home /opt/sisglosa sisglosa
runuser -u sisglosa -- git clone https://github.com/h3nrique-beep/guias-pmgu.git /opt/sisglosa
cd /opt/sisglosa
runuser -u sisglosa -- npm install --omit=dev
install -d -o sisglosa -g sisglosa /opt/sisglosa/data
install -d -m 750 -o root -g sisglosa /etc/sisglosa
install -m 640 -o root -g sisglosa .env.example /etc/sisglosa/sisglosa.env
```

Se o repositório for privado, o `git clone` pede credenciais: use um token de acesso ou uma *deploy key*. Mantenha `COOKIE_SECURE=false` em `/etc/sisglosa/sisglosa.env` enquanto o acesso for HTTP interno; depois de configurar HTTPS, altere para `true` e reinicie o serviço.

### Levar as guias da máquina atual (opcional)

O banco guarda também os **usuários e senhas**; ao importá-lo, o acesso inicial `admin` deixa de valer e passam a valer as contas já existentes. Na máquina atual (Windows), pare o SISGLOSA e consolide o banco, porque parte dos dados fica no arquivo `guias.db-wal`:

```powershell
node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/guias.db').exec('PRAGMA wal_checkpoint(TRUNCATE)')"
```

Copie somente `data/guias.db` para `/opt/sisglosa/data/guias.db` na VM e ajuste o dono, com o serviço ainda parado:

```bash
chown sisglosa:sisglosa /opt/sisglosa/data/guias.db
chmod 600 /opt/sisglosa/data/guias.db
```

## 3. Serviço e proxy

```bash
install -m 644 deploy/proxmox/sisglosa.service /etc/systemd/system/sisglosa.service
install -m 644 deploy/proxmox/nginx.conf /etc/nginx/sites-available/sisglosa
ln -s /etc/nginx/sites-available/sisglosa /etc/nginx/sites-enabled/sisglosa
rm -f /etc/nginx/sites-enabled/default
systemctl daemon-reload
nginx -t
systemctl enable --now sisglosa nginx
```

O acesso interno é `http://IP_DA_MÁQUINA/`. A aplicação fica limitada a `127.0.0.1:8080`; apenas o Nginx é exposto na rede. Verifique:

```bash
curl http://127.0.0.1/health
systemctl status sisglosa
```

## 4. Primeiro acesso e usuários

Num banco novo, o acesso inicial é `admin` / `Admin@123456`, e o sistema exige a troca imediata da senha (mínimo de 8 caracteres, com maiúscula, minúscula, número e símbolo). **Faça isso antes de liberar o acesso na rede.**

Para definir a senha do administrador diretamente (por exemplo, uma senha própria da instituição) e deixar o painel só com essa conta, use o script abaixo. Ele também serve para recuperar uma senha esquecida, e a senha não é gravada em arquivo. Rode depois do primeiro início, que cria o banco:

```bash
cd /opt/sisglosa
read -rs -p 'Senha do administrador: ' ADMIN_PASSWORD; echo; export ADMIN_PASSWORD
runuser -u sisglosa -- node scripts/definir-admin.js --remover-outros
unset ADMIN_PASSWORD
```

Sem `--remover-outros`, as demais contas são mantidas. O script não impõe a política de senha do painel (apenas avisa), então prefira uma senha longa. Se for **levar o banco da máquina atual**, ele já traz esse `admin`, e este passo não é necessário.

O sistema foi pensado para dois usuários:

- **`admin`**: gerencia acessos e atualizações. Na tela **Administração** acompanha todas as contas, vê quem ainda precisa trocar a senha, redefine senhas e remove usuários. Por projeto, o administrador não acessa as guias.
- **Usuário de operação** (auditor): em **Administração › Novo acesso**, crie a conta com perfil **Usuário**. A senha temporária é exibida uma única vez; o usuário a troca no primeiro acesso.

## 5. Atualizações pelo painel (pacote .zip)

O pacote é sempre gerado neste projeto, na máquina de desenvolvimento (a pasta do código, nunca na VM), no mesmo modelo do Sentinela: um comando monta o `.zip` e o painel o valida e aplica.

```bash
npm run pacote -- --versao 2.0.1 --mensagem "Corrige a impressão do relatório" --tipo corretiva
```

O comando grava `output/pacotes/sisglosa-2.0.1.zip` e mostra os arquivos, o tamanho e o SHA-256. Opções: `--tipo corretiva|evolutiva` (padrão `corretiva`), `--arquivos public/app.js,public/styles.css` (só esses), `--desde <commit-ou-tag>` (só o que mudou desde essa referência), `--saida <pasta>` e `--forcar` (sobrescreve um pacote existente). Sem `--arquivos` nem `--desde`, o pacote leva todos os arquivos permitidos.

Em **Desenvolvedor › Aplicar pacote de atualização**, o administrador envia o `.zip` (até 25 MB) e informa a próxima versão, o tipo (corretiva ou evolutiva) e a descrição do que mudou. O pacote traz o manifesto `sisglosa-update.json`, gerado pelo comando, e somente os arquivos listados nele:

```json
{
  "product": "SISGLOSA",
  "version": "2.0.1",
  "type": "corretiva",
  "message": "Corrige a impressão do relatório",
  "files": ["public/app.js", "public/styles.css"]
}
```

São aceitos apenas `server.js`, `lib/passwords.js`, `lib/pacote.js`, `public/index.html`, `public/app.js` e `public/styles.css`. Antes de aplicar, o sistema valida o manifesto (versão, mensagem e tipo), recusa qualquer outro arquivo e recusa arquivo JavaScript com erro de sintaxe. Depois guarda uma cópia dos arquivos substituídos **e do banco** (`guias.db`) em `data/updates/backups/<carimbo>/` e registra versão, tipo, mensagem e arquivos no histórico da tela.

Depois de aplicar:

- se o pacote alterou só a interface (`public/*`), recarregue a página;
- se alterou `server.js` ou `lib/passwords.js`, o painel avisa e é preciso reiniciar: `systemctl restart sisglosa`.

**Recuperação.** Se uma atualização causar problema, restaure a cópia anterior e reinicie:

```bash
runuser -u sisglosa -- cp -a /opt/sisglosa/data/updates/backups/<carimbo>/. /opt/sisglosa/
systemctl restart sisglosa
curl http://127.0.0.1:8080/health
```

Se a atualização também mudou o banco e for preciso voltá-lo, pare o serviço (`systemctl stop sisglosa`), copie `guias.db` da mesma pasta de cópia para `/opt/sisglosa/data/guias.db` (dono `sisglosa`, permissão `600`) e inicie de novo. Com MySQL, use o backup diário.

### Atualização por Git (alternativa)

Use um único caminho de atualização. Se algum pacote `.zip` já foi aplicado, os arquivos diferem do Git e o `git pull` recusa a operação; só descarte as alterações do pacote (`runuser -u sisglosa -- git checkout -- server.js lib public`) se o conteúdo dele já estiver no repositório.

```bash
cd /opt/sisglosa
runuser -u sisglosa -- git pull --ff-only
runuser -u sisglosa -- npm install --omit=dev
systemctl restart sisglosa
curl http://127.0.0.1:8080/health
```

Após alterações no Nginx, valide antes de recarregar: `nginx -t && systemctl reload nginx`.

## 6. Backup

Instale o script com permissão restrita e execute-o diariamente pelo `root`:

```bash
install -m 700 deploy/proxmox/backup-sisglosa.sh /usr/local/sbin/backup-sisglosa
crontab -e
# 02:15 diariamente
15 2 * * * set -a; . /etc/sisglosa/sisglosa.env; set +a; /usr/local/sbin/backup-sisglosa
```

O script mantém 30 dias de cópias em `/var/backups/sisglosa`. Além dele, configure um *backup job* da própria máquina no Proxmox para outro armazenamento.

## 7. HTTPS

Coloque o nome DNS no `server_name` do Nginx e emita um certificado antes de liberar o acesso externo; depois defina `COOKIE_SECURE=true` e reinicie o serviço.

## Opcional: MySQL/MariaDB

O SQLite atende a esta carga. Para usar MySQL/MariaDB, instale `mariadb-client`, descomente e preencha as linhas `DB_*` em `/etc/sisglosa/sisglosa.env`, reinicie o serviço e, para levar as guias existentes, mantenha `data/guias.db` e execute:

```bash
cd /opt/sisglosa
runuser -u sisglosa -- env $(grep -v '^#' /etc/sisglosa/sisglosa.env | xargs) node scripts/migrate-sqlite-to-mysql.js
```
