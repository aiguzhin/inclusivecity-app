#!/usr/bin/env bash
# Установка ICity на свой сервер (Ubuntu 22.04/24.04, ps.kz).
# Запуск на сервере от root:  bash install.sh
# Ничего не ломает рядом: Cosplaygram и другие сайты на этом сервере остаются как были.
set -euo pipefail

REPO="git@github.com:aiguzhin/inclusivecity-app.git"
APP=/opt/icity
PORT=3010
DOMAINS="inclusivecity.uk www.inclusivecity.uk"
MAIL="inclusivecityimpact@gmail.com"
RENDER_SERVICE=srv-db4agdbtqb8s73el6ka0
KEY=/root/.ssh/icity_deploy

say(){ printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "Запустите от root"

say "1/7 Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates python3 dnsutils >/dev/null
NODEV=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "${NODEV:-0}" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v)"

say "2/7 Ключ для скачивания кода с GitHub"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -C "icity-vps" -f "$KEY"
grep -q "icity_deploy" /root/.ssh/config 2>/dev/null || cat >> /root/.ssh/config <<CFG
Host github-icity
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
CFG
ssh-keyscan -q github.com >> /root/.ssh/known_hosts 2>/dev/null || true
REPO_SSH="github-icity:aiguzhin/inclusivecity-app.git"
until git ls-remote -q "$REPO_SSH" HEAD >/dev/null 2>&1; do
  echo
  echo "Добавьте этот ключ на GitHub (Title — любое, галочку «Allow write access» НЕ ставить):"
  echo "  https://github.com/aiguzhin/inclusivecity-app/settings/keys/new"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Добавили? Нажмите Enter… " _ </dev/tty
done
ok "Доступ к репозиторию есть"

say "3/7 Код ICity"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin main && git -C "$APP" reset -q --hard origin/main
else
  git clone -q "$REPO_SSH" "$APP"
fi
mkdir -p "$APP/data" "$APP/uploads"
ok "Код в $APP ($(git -C "$APP" log -1 --format=%h))"

say "4/7 Настройки (ключи) из Render"
ENVF=/etc/icity.env
if [ ! -s "$ENVF" ]; then
  echo "Нужен ключ Render API (Render → Account Settings → API Keys → Create API Key)."
  read -r -s -p "Вставьте ключ Render API и нажмите Enter (символы не видны): " RKEY </dev/tty; echo
  RKEY="$RKEY" python3 - "$RENDER_SERVICE" > "$ENVF.tmp" <<'PY'
import json, os, sys, urllib.request
svc=sys.argv[1]; key=os.environ['RKEY']; out=[]; cursor=''
while True:
    url=f'https://api.render.com/v1/services/{svc}/env-vars?limit=100'+(f'&cursor={cursor}' if cursor else '')
    req=urllib.request.Request(url, headers={'Authorization':'Bearer '+key,'Accept':'application/json'})
    data=json.load(urllib.request.urlopen(req, timeout=30))
    if not data: break
    for it in data:
        ev=it.get('envVar',it); out.append((ev['key'], ev.get('value','')))
    cursor=data[-1].get('cursor','')
    if len(data)<100 or not cursor: break
for k,v in out:
    if k in ('PORT','HOST','RENDER_EXTERNAL_URL'): continue
    v=v.replace('\\','\\\\').replace('"','\\"').replace('\n','\\n')
    print(f'{k}="{v}"')
print(f'# перенесено из Render: {len(out)} переменных', file=sys.stderr)
PY
  { cat "$ENVF.tmp"; echo "PORT=$PORT"; echo "HOST=127.0.0.1"; } > "$ENVF"; rm -f "$ENVF.tmp"; chmod 600 "$ENVF"
fi
ok "Настройки в $ENVF ($(grep -c = "$ENVF") строк)"

say "5/7 Автозапуск и автообновление"
cat > /etc/systemd/system/icity.service <<UNIT
[Unit]
Description=ICity (inclusivecity.uk)
After=network-online.target
[Service]
WorkingDirectory=$APP
EnvironmentFile=$ENVF
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
cat > /usr/local/bin/icity-update <<'UPD'
#!/usr/bin/env bash
# Раз в 2 минуты: есть новый коммит в main — обновляем и перезапускаем
cd /opt/icity || exit 0
git fetch -q origin main || exit 0
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git reset -q --hard origin/main && systemctl restart icity && echo "updated to $(git log -1 --format=%h)"
fi
UPD
chmod +x /usr/local/bin/icity-update
cat > /etc/systemd/system/icity-update.service <<UNIT
[Unit]
Description=ICity: обновление из GitHub
[Service]
Type=oneshot
ExecStart=/usr/local/bin/icity-update
UNIT
cat > /etc/systemd/system/icity-update.timer <<UNIT
[Unit]
Description=ICity: проверять обновления каждые 2 минуты
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable -q --now icity icity-update.timer
systemctl restart icity
for i in $(seq 1 20); do curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 1; done
curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null || { journalctl -u icity -n 30 --no-pager; die "ICity не запустился"; }
ok "ICity работает на 127.0.0.1:$PORT"

say "6/7 Веб-сервер и HTTPS"
WEB=none
if systemctl is-active -q caddy 2>/dev/null; then WEB=caddy
elif systemctl is-active -q nginx 2>/dev/null; then WEB=nginx
elif ss -ltn '( sport = :80 or sport = :443 )' | grep -q LISTEN; then
  ss -ltnp '( sport = :80 or sport = :443 )'; die "Порт 80/443 занят неизвестной программой — напишите Claude, что показано выше"
fi
echo "Найден: $WEB"
if [ "$WEB" = none ]; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  : > /etc/caddy/Caddyfile
  WEB=caddy
fi
if [ "$WEB" = caddy ]; then
  if ! grep -q "inclusivecity.uk" /etc/caddy/Caddyfile; then
    cat >> /etc/caddy/Caddyfile <<CAD

# ICity
inclusivecity.uk, www.inclusivecity.uk {
	encode gzip
	request_body {
		max_size 20MB
	}
	reverse_proxy 127.0.0.1:$PORT
}
CAD
  fi
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  systemctl reload caddy || systemctl restart caddy
  ok "Caddy: сертификат HTTPS выпустится сам, как только домен будет смотреть на этот сервер"
else
  cat > /etc/nginx/sites-available/inclusivecity.uk <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name inclusivecity.uk www.inclusivecity.uk;
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 150s;
    }
}
NGX
  ln -sf /etc/nginx/sites-available/inclusivecity.uk /etc/nginx/sites-enabled/inclusivecity.uk
  nginx -t -q && systemctl reload nginx
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  ok "nginx настроен; HTTPS выпустим после смены DNS"
fi

say "7/7 Домен"
IP=$(curl -4 -fs https://api.ipify.org || hostname -I | awk '{print $1}')
echo "IP сервера: $IP"
echo "Ждём, пока inclusivecity.uk начнёт смотреть на $IP (DNS меняется в Cloudflare)…"
for i in $(seq 1 120); do
  [ "$(dig +short A inclusivecity.uk @1.1.1.1 | tail -1)" = "$IP" ] && break; sleep 15
done
if [ "$(dig +short A inclusivecity.uk @1.1.1.1 | tail -1)" = "$IP" ]; then
  if [ "$WEB" = nginx ]; then
    certbot --nginx -n --agree-tos -m "$MAIL" --redirect -d inclusivecity.uk -d www.inclusivecity.uk
  else
    sleep 20
  fi
  curl -fsS -o /dev/null -w "https://inclusivecity.uk → HTTP %{http_code}\n" https://inclusivecity.uk/api/health || true
  ok "Готово! ICity работает на этом сервере"
else
  echo "DNS ещё не сменился. Когда смените — запустите ещё раз: bash install.sh (ничего не сломает)"
fi
