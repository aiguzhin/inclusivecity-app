#!/usr/bin/env bash
# Возвращает ICity в общий Caddy Cosplaygram, если его настройка пропала (так было 14.11.2026:
# https://inclusivecity.uk отвечал «tlsv1 alert internal error» — Caddy не знал этот домен).
# Делает то же, что шаг 6 install.sh. Повторный запуск безопасен; при ошибке возвращает как было.
# Запускает его сам сервер ICity (selfheal.js), когда https перестаёт отвечать.
set -uo pipefail
CG=/opt/cosplaygram
ENVF=/etc/icity.env
echo "== $(date '+%F %T') =="
[ -f "$CG/docker-compose.yml" ] || { echo "нет $CG — пропускаю"; exit 0; }
PORT=$(grep -E '^PORT=' "$ENVF" 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"'); PORT=${PORT:-3010}
BIND=$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1); BIND=${BIND:-172.17.0.1}
cd "$CG" || exit 1
echo "-- было:"; ls -la docker-compose.override.yml deploy/Caddyfile.icity 2>&1
docker compose ps caddy 2>&1 | tail -2
OVR=docker-compose.override.yml
if [ -f "$OVR" ] && ! grep -q "Caddyfile.icity" "$OVR"; then echo "есть чужой $OVR — не трогаю"; exit 1; fi
BAK=$(mktemp -d); cp -a "$OVR" deploy/Caddyfile.icity "$BAK"/ 2>/dev/null
cat > deploy/Caddyfile.icity <<CAD
import /etc/caddy/cosplaygram.caddy

# ICity
inclusivecity.uk, www.inclusivecity.uk {
	encode gzip
	request_body {
		max_size 20MB
	}
	reverse_proxy $BIND:$PORT
}
CAD
cat > "$OVR" <<YML
# ICity: общий Caddy. Файл не в git, автообновление Cosplaygram его не трогает.
services:
  caddy:
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/cosplaygram.caddy:ro
      - ./deploy/Caddyfile.icity:/etc/caddy/Caddyfile:ro
YML
grep -qx "docker-compose.override.yml" .git/info/exclude 2>/dev/null || printf 'docker-compose.override.yml\ndeploy/Caddyfile.icity\n' >> .git/info/exclude
restore(){
  rm -f "$OVR" deploy/Caddyfile.icity
  [ -f "$BAK/docker-compose.override.yml" ] && cp -a "$BAK/docker-compose.override.yml" "$OVR"
  [ -f "$BAK/Caddyfile.icity" ] && cp -a "$BAK/Caddyfile.icity" deploy/Caddyfile.icity
  docker compose up -d --no-deps --force-recreate caddy >/dev/null 2>&1
}
if ! OUT=$(docker compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1); then
  echo "$OUT" | tail -5; echo "проверка настройки не прошла — возвращаю как было"; restore; exit 1
fi
docker compose up -d --no-deps --force-recreate caddy 2>&1 | tail -2
sleep 8
if ! docker compose ps caddy --format '{{.State}}' | grep -q running; then
  docker compose logs --tail 20 caddy; echo "Caddy не запустился — возвращаю как было"; restore; exit 1
fi
for i in $(seq 1 12); do
  if curl -fsk --max-time 10 --resolve inclusivecity.uk:443:127.0.0.1 https://inclusivecity.uk/api/health >/dev/null; then echo "OK: https://inclusivecity.uk отвечает"; exit 0; fi
  sleep 10
done
echo "https пока не отвечает, журнал Caddy:"; docker compose logs --tail 30 caddy 2>&1 | grep -i "inclusivecity\|error\|acme" | tail -15
exit 2
