#!/usr/bin/env bash
# Roda no Shell do NÓ Proxmox (não no CT). Instala o SISGLOSA offline dentro do CT informado.
# Antes, envie pela interface web (local > CT Templates > Upload):
#   sisglosa-offline.tar.gz          (obrigatório)
#   sisglosa-banco.tar.gz            (opcional: guias.db da máquina atual)
# Uso: bash <(tar -xzOf /var/lib/vz/template/cache/sisglosa-offline.tar.gz instalar-no-proxmox.sh) 112
set -euo pipefail
ct="${1:?Informe o número do CT, por exemplo 112}"
cache=/var/lib/vz/template/cache
pkg="$cache/sisglosa-offline.tar.gz"
db="$cache/sisglosa-banco.tar.gz"
[[ -f "$pkg" ]] || { echo "Não encontrei $pkg. Envie o arquivo em local > CT Templates > Upload."; exit 1; }

pct status "$ct" | grep -q running || { pct start "$ct"; sleep 5; }
pct push "$ct" "$pkg" /root/sisglosa-offline.tar.gz
if [[ -f "$db" ]]; then pct push "$ct" "$db" /root/sisglosa-banco.tar.gz; echo "Banco enviado."; fi

pct exec "$ct" -- bash -c '
  set -e
  cd /root
  rm -rf sisglosa node-v*-linux-x64.tar.gz guias.db
  tar -xzf sisglosa-offline.tar.gz --no-same-owner
  if [ -f sisglosa-banco.tar.gz ]; then tar -xzf sisglosa-banco.tar.gz --no-same-owner; fi
  bash sisglosa/deploy/proxmox/instalar-offline.sh
  # O banco tem as senhas (hash) dos usuários: não deixa cópia solta em /root.
  rm -f guias.db sisglosa-banco.tar.gz
' </dev/null

rules="/nodes/$(hostname)/lxc/$ct/firewall/rules"
pvesh get "$rules" --output-format json | grep -q '"dport":"80"' \
  || pvesh create "$rules" --type in --action ACCEPT --proto tcp --dport 80 --enable 1 --comment SISGLOSA
echo "Regra de firewall do CT $ct: porta 80 liberada."

# Os arquivos enviados aparecem como "templates" de CT; remove para não confundir (e não deixar o banco no storage).
rm -f "$pkg" "$db"
echo "Pronto."
