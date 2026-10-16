#!/usr/bin/env bash
set -euo pipefail

backup_dir="${BACKUP_DIR:-/var/backups/sisglosa}"
stamp="$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup_dir"

if [[ -n "${DB_HOST:-}" ]]; then
  : "${DB_NAME:?DB_NAME é obrigatório}"
  : "${DB_USER:?DB_USER é obrigatório}"
  : "${DB_PASSWORD:?DB_PASSWORD é obrigatório}"
  MYSQL_PWD="$DB_PASSWORD" mariadb-dump --host="$DB_HOST" --port="${DB_PORT:-3306}" --user="$DB_USER" --single-transaction --routines --events "$DB_NAME" | gzip > "$backup_dir/mysql-$stamp.sql.gz"
elif command -v sqlite3 >/dev/null; then
  sqlite3 /opt/sisglosa/data/guias.db ".backup '$backup_dir/guias-$stamp.db'"
  chmod 600 "$backup_dir/guias-$stamp.db"
else
  # Instalação offline, sem o pacote sqlite3: cópia consistente pelo próprio Node.
  node -e 'const [db, out] = process.argv.slice(1); new (require("node:sqlite").DatabaseSync)(db).exec("VACUUM INTO '\''" + out + "'\''")' /opt/sisglosa/data/guias.db "$backup_dir/guias-$stamp.db"
  chmod 600 "$backup_dir/guias-$stamp.db"
fi

find "$backup_dir" -type f -mtime +30 -delete
