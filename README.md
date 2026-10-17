# SISGLOSA

<p align="center">
  <img src="public/sisglosa.jpg" alt="SISGLOSA — Sistema de Relatório de Glosa para Auditoria" width="280">
</p>

<p align="center">
  Sistema local de relatórios de ajuste e glosa para auditoria de contas médicas do PMGU — Posto Médico da Guarnição de Cascavel.
</p>

**Versão:** 2.0.0

## Visão geral

O SISGLOSA centraliza o registro das guias, calcula os valores auditados e gera relatórios prontos para pré-visualização, impressão ou exportação em PDF, no padrão PMGU.

## Principais recursos

- Criação, edição, consulta e exclusão de guias em rascunho ou finalizadas.
- Módulos específicos de ajuste e glosa, incluindo honorários, taxas, materiais, medicamentos, exames, OPME, nutrição e fisioterapia.
- Registro de especialidade e CRM para itens de honorários.
- Cálculo automático: **valor auditado = valor apresentado − glosa + ajuste**.
- Reaproveitamento de OCS e especificações já cadastradas.
- Painel com indicadores e guias recentes.
- Relatórios organizados por módulo, prontos para impressão/PDF.
- Número do atendimento editável, rodapé padrão e registro da data de finalização.
- Sugestões reutilizáveis das justificativas já registradas.
- Controle de acesso com usuários, troca obrigatória de senha inicial e administração de contas.
- Guias finalizadas podem ser editadas por até 30 dias; depois disso permanecem disponíveis apenas para consulta e impressão.
- Backups do banco (automático diário, manual, antes de cada atualização e antes de restaurar), com download cifrado e restauração pelo painel.
- Monitor de saúde com alertas: erros do servidor, rajada de falhas de login, disco, RAM, código alterado fora de atualização, integridade do banco e backup atrasado.

## Requisitos

- Node.js 22.13 ou superior

## Instalação e execução

```powershell
npm install
npm start
```

Acesse `http://localhost:8080`.

No primeiro acesso, utilize as credenciais abaixo e altere a senha imediatamente:

| Usuário | Senha inicial |
| --- | --- |
| `admin` | `Admin@123456` |

> A conta `admin` é exclusiva para a administração de usuários. Crie contas individuais para operar as guias.

## Armazenamento de dados

Por padrão, a aplicação utiliza SQLite e cria automaticamente o arquivo `data/guias.db` na primeira execução.

Para utilizar MySQL ou MariaDB, defina as variáveis de ambiente antes de iniciar o sistema:

```powershell
$env:DB_HOST = '127.0.0.1'
$env:DB_PORT = '3306'
$env:DB_NAME = 'sisglosa'
$env:DB_USER = 'sisglosa'
$env:DB_PASSWORD = 'troque_esta_senha'
npm start
```

As tabelas são criadas automaticamente. Para migrar as guias existentes no SQLite para MySQL/MariaDB, mantenha `data/guias.db` disponível e execute:

```powershell
npm run migrate:sqlite
```

## Comandos disponíveis

```powershell
npm run check          # verifica a sintaxe, a autenticação e os backups/monitor
npm start              # inicia a aplicação
npm run pacote         # gera o pacote .zip de atualização
npm run migrate:sqlite # migra SQLite para MySQL/MariaDB
node scripts/abrir-backup.js <arquivo.sgbk> <saida.db>  # decifra um backup baixado pelo painel
```

O servidor usa a porta `8080` e aceita conexões apenas em `127.0.0.1`. Para alterar a porta, defina a variável `PORT` antes da execução.

## Atualizações pelo administrador

O pacote é gerado com um comando e aplicado pela tela **Desenvolvedor**:

```powershell
npm run pacote -- --versao 2.0.1 --mensagem "Descrição da mudança" --tipo corretiva
```

O comando cria `output/pacotes/sisglosa-2.0.1.zip` com o manifesto `sisglosa-update.json` (versão, tipo, mensagem e arquivos). Opções: `--tipo corretiva|evolutiva`, `--arquivos a,b` (só esses), `--desde <commit-ou-tag>` (só o que mudou), `--saida <pasta>` e `--forcar`.

O pacote pode trazer arquivos novos ou alterados de `server.js`, `package.json`, `package-lock.json`, `lib/`, `public/`, `scripts/` e `deploy/` (até 300 arquivos); `data/`, `node_modules/`, `.env` e arquivos ocultos são sempre recusados. Se o pacote trouxer `package.json`, o painel roda `npm install --omit=dev` antes de reiniciar (o CT precisa de acesso à internet; sem ele o pacote é recusado e desfeito). Ao enviar o `.zip`, o administrador vê o resultado e o sistema valida o manifesto, bloqueia arquivos fora dessa lista, recusa JavaScript com erro de sintaxe e guarda uma cópia dos arquivos substituídos e do banco SQLite em `data/updates/backups`. O histórico mostra versão, tipo, mensagem e arquivos. Atualizações que incluam `server.js`, `lib/passwords.js` ou `lib/pacote.js` exigem reinício do serviço.

Versão e descrição do manifesto (gerado por `npm run pacote`) valem sobre as digitadas no painel; o tipo é o escolhido no painel. Descrição só com pontuação (ex.: `.`) conta como vazia. **Reversão:** enviar o pacote de uma versão menor que a ativa é aceito e volta o código para ela.

## Backups do banco

Com SQLite, o painel do administrador gerencia os backups em `data/backups` (ou na pasta de `BACKUP_ROOT`). Cada backup é um `.db` com um `.json` ao lado; o histórico de ações fica em `historico.jsonl`, que não é apagado por uma restauração.

| Tipo | Quando | Quanto tempo fica |
|---|---|---|
| `auto` | Uma vez por dia, verificado a cada hora pelo próprio serviço | 90 dias |
| `manual` | Botão no painel | Os 20 mais recentes entre manual, pre-update e pre-restore |
| `pre-update` | Antes de aplicar um pacote de atualização | idem |
| `pre-restore` | Antes de restaurar outro backup | idem |

- **Baixar:** pede a senha do administrador e uma frase-senha; o arquivo sai cifrado (`.sgbk`, AES-256-GCM com chave derivada por scrypt). Para abrir: `node scripts/abrir-backup.js arquivo.sgbk saida.db`.
- **Restaurar:** pede a senha e a palavra `RESTAURAR`. Troca o banco sem reiniciar o serviço, mantém a versão do código que está rodando e encerra todas as sessões (todos entram de novo).
- **MySQL/MariaDB:** o painel não faz backup; use `deploy/proxmox/backup-sisglosa.sh`.

## Monitor de saúde

Roda dentro do próprio serviço, sem cron. Cada problema gera um alerta único (atualizado em vez de duplicado) que fecha sozinho quando a condição some.

| Alerta | Condição | Gravidade |
|---|---|---|
| Erros do servidor | Mais de 2% de respostas 5xx na última hora (com pelo menos 50 requisições) | Alto |
| Muitas falhas de login | Rajada de senhas erradas em 10 minutos | Alto |
| Pouco espaço em disco | Menos de 10% livre na partição do banco (menos de 5%: crítico) | Alto/Crítico |
| RAM alta | Acima de 90% por 30 minutos | Alto |
| Código alterado fora de uma atualização | Arquivos de `server.js`, `package*.json`, `lib/`, `public/` ou `scripts/` diferentes da referência | Crítico |
| Banco com erro de integridade | `PRAGMA quick_check` diferente de `ok` | Crítico |
| Backup atrasado / com falha | Último backup com mais de 26 horas ou reprovado na verificação | Alto |

A referência de integridade do código é renovada a cada pacote aplicado pelo painel. Uma alteração legítima feita fora do painel é aceita pelo administrador com a própria senha (**Aceitar arquivos atuais**).

## Implantação no Proxmox VE

As instruções de implantação com Nginx e MySQL/MariaDB estão em [deploy/proxmox/README.md](https://github.com/h3nrique-beep/guias-pmgu/blob/main/deploy/proxmox/README.md).
