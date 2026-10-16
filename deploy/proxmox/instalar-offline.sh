#!/usr/bin/env bash
# Instalação do SISGLOSA num CT/VM sem acesso à internet.
# Rode como root na pasta extraída do sisglosa-offline.tar.gz:
#   bash sisglosa/deploy/proxmox/instalar-offline.sh
# Se houver um guias.db ao lado deste pacote (na mesma pasta do node-*.tar.gz), ele é importado.
set -euo pipefail
cd "$(dirname "$0")/../../.."

node_tar=$(ls node-v*-linux-x64.tar.gz | head -1)
tar -xzf "$node_tar" -C /usr/local --strip-components=1 --no-same-owner
ln -sf /usr/local/bin/node /usr/bin/node
node --version
if [[ -f /usr/share/zoneinfo/America/Sao_Paulo ]]; then ln -sf /usr/share/zoneinfo/America/Sao_Paulo /etc/localtime; echo America/Sao_Paulo > /etc/timezone; fi

id sisglosa >/dev/null 2>&1 || adduser --system --group --no-create-home --home /opt/sisglosa sisglosa
install -d -o sisglosa -g sisglosa /opt/sisglosa /opt/sisglosa/data
cp -a sisglosa/. /opt/sisglosa/
chown -R sisglosa:sisglosa /opt/sisglosa

if [[ -f guias.db && ! -f /opt/sisglosa/data/guias.db ]]; then
  install -m 600 -o sisglosa -g sisglosa guias.db /opt/sisglosa/data/guias.db
  echo "Banco importado."
fi

install -d -m 750 -o root -g sisglosa /etc/sisglosa
if [[ ! -f /etc/sisglosa/sisglosa.env ]]; then
  install -m 640 -o root -g sisglosa /opt/sisglosa/.env.example /etc/sisglosa/sisglosa.env
  # Sem Nginx, a própria aplicação atende na porta 80 (endereço sem ":8080").
  sed -i 's/^PORT=.*/PORT=80/' /etc/sisglosa/sisglosa.env
  echo 'HOST=0.0.0.0' >> /etc/sisglosa/sisglosa.env
fi
port=$(sed -n 's/^PORT=//p' /etc/sisglosa/sisglosa.env)

install -m 644 /opt/sisglosa/deploy/proxmox/sisglosa.service /etc/systemd/system/sisglosa.service
# Porta abaixo de 1024 exige CAP_NET_BIND_SERVICE; o serviço continua rodando como o usuário sisglosa.
install -d /etc/systemd/system/sisglosa.service.d
printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\n' > /etc/systemd/system/sisglosa.service.d/porta-baixa.conf
install -m 700 /opt/sisglosa/deploy/proxmox/backup-sisglosa.sh /usr/local/sbin/backup-sisglosa
systemctl daemon-reload
systemctl enable sisglosa
systemctl restart sisglosa
for _ in $(seq 20); do
  node -e "fetch('http://127.0.0.1:$port/health').then(r => { console.log('health:', r.status); process.exit(r.ok ? 0 : 1); }).catch(() => process.exit(1))" && break
  sleep 1
done || true
systemctl is-active --quiet sisglosa || { journalctl -u sisglosa -n 30 --no-pager; exit 1; }
echo "Acesse: http://$(hostname -I | awk '{print $1}')$([[ $port == 80 ]] || echo ":$port")/"
