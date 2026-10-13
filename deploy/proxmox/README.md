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

Acesse `http://IP_DA_MÁQUINA/` e entre com `admin` / `Admin@123456`. O sistema exige a troca imediata da senha (mínimo de 8 caracteres, com maiúscula, minúscula, número e símbolo). **Faça isso antes de liberar o acesso na rede.**

O sistema foi pensado para dois usuários:

- **`admin`**: gerencia acessos e atualizações. Na tela **Administração** acompanha todas as contas, vê quem ainda precisa trocar a senha, redefine senhas e remove usuários. Por projeto, o administrador não acessa as guias.
- **Usuário de operação** (auditor): em **Administração › Novo acesso**, crie a conta com perfil **Usuário**. A senha temporária é exibida uma única vez; o usuário a troca no primeiro acesso.

## 5. Atualizações pelo painel (pacote .zip)

Em **Administração › Atualizações do SISGLOSA**, o administrador envia um pacote `.zip` de até 25 MB. O pacote deve trazer, na raiz, o manifesto `sisglosa-update.json` e somente os arquivos listados nele:

```json
{
  "product": "SISGLOSA",
  "version": "2.0.1",
  "files": ["public/app.js", "public/styles.css"]
}
```

São aceitos apenas `server.js`, `lib/passwords.js`, `public/index.html`, `public/app.js` e `public/styles.css`. O sistema valida o manifesto, recusa qualquer outro arquivo, guarda uma cópia dos arquivos substituídos em `data/updates/backups/<carimbo>/` e registra o pacote no histórico.

Para montar o pacote no Windows, a partir da pasta do projeto (mantém os caminhos internos):

```powershell
tar -a -c -f sisglosa-2.0.1.zip sisglosa-update.json public/app.js public/styles.css
```

Depois de aplicar:

- se o pacote alterou só a interface (`public/*`), recarregue a página;
- se alterou `server.js` ou `lib/passwords.js`, o painel avisa e é preciso reiniciar: `systemctl restart sisglosa`.

**Recuperação.** Se uma atualização causar problema, restaure a cópia anterior e reinicie:

```bash
runuser -u sisglosa -- cp -a /opt/sisglosa/data/updates/backups/<carimbo>/. /opt/sisglosa/
systemctl restart sisglosa
curl http://127.0.0.1:8080/health
```

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
