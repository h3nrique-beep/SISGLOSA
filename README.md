# SISGLOSA

<p align="center">
  <img src="public/sisglosa.jpg" alt="SISGLOSA — Sistema de Relatório de Glosa para Auditoria" width="280">
</p>

<p align="center">
  Sistema local de relatórios de ajuste e glosa para auditoria de contas médicas do PMGU — Posto Médico da Guarnição de Cascavel.
</p>

**Versão:** 1.1.4

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

## Requisitos

- Node.js 22.5 ou superior

## Instalação e execução

```powershell
npm install
npm start
```

Acesse `http://localhost:8081`.

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
npm run check          # verifica a sintaxe e a autenticação básica
npm start              # inicia a aplicação
npm run migrate:sqlite # migra SQLite para MySQL/MariaDB
```

O servidor usa a porta `8081` e aceita conexões apenas em `127.0.0.1`. Para alterar a porta, defina a variável `PORT` antes da execução.

## Implantação no Proxmox VE

As instruções de implantação com Nginx e MySQL/MariaDB estão em [deploy/proxmox/README.md](https://github.com/h3nrique-beep/guias-pmgu/blob/main/deploy/proxmox/README.md).
