#!/usr/bin/env bash
# Installs (or updates) Officier and the QMS gateway from an unpacked release package on a Linux server.
#
#   tar -xf officier-0.2.0-package.tar && cd officier-0.2.0
#   sudo bash /path/to/officier-install.sh --public-url https://docs.example.kz --gateway-bind 10.0.0.5
#
# Options:
#   --public-url URL      address of the document server as browsers see it (required on first install)
#   --gateway-bind IP     interface for the QMS gateway; the portal backend connects here (127.0.0.1)
#   --bind IP             interface for the document server port, for the HTTPS proxy (127.0.0.1)
#   --port N              document server port on the host (8080)
#   --gateway-port N      QMS gateway port on the host (8081)
#   --dir DIR             installation directory with compose.yaml and .env (/opt/officier)
#   --package DIR         unpacked release package (current directory or the one above this script)
# An existing .env keeps its secrets: running the installer of a newer package updates the images.
set -euo pipefail

public_url=""; gateway_bind=""; bind=""; port=""; gateway_port=""; dir=/opt/officier; package=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url) public_url="${2:?}"; shift 2 ;;
    --gateway-bind) gateway_bind="${2:?}"; shift 2 ;;
    --bind) bind="${2:?}"; shift 2 ;;
    --port) port="${2:?}"; shift 2 ;;
    --gateway-port) gateway_port="${2:?}"; shift 2 ;;
    --dir) dir="${2:?}"; shift 2 ;;
    --package) package="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
fail() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }
warn() { printf 'ВНИМАНИЕ: %s\n' "$*" >&2; }

# The package: given, the current directory, or the directory above this script.
if [[ -z "$package" ]]; then
  for candidate in "$PWD" "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; do
    if [[ -f "$candidate/SHA256SUMS" && -d "$candidate/images" ]]; then package="$candidate"; break; fi
  done
fi
[[ -n "$package" && -f "$package/SHA256SUMS" ]] || fail "не найден распакованный пакет (папка с SHA256SUMS и images/): запустите из officier-<версия> или укажите --package"
officier_tar="$(ls "$package"/images/officier-[0-9]*.tar.gz 2>/dev/null | head -1)"
gateway_tar="$(ls "$package"/images/officier-qms-gateway-*.tar.gz 2>/dev/null | head -1)"
[[ -n "$officier_tar" && -n "$gateway_tar" ]] || fail "в $package/images нет образов"
version="$(basename "$officier_tar" .tar.gz)"; version="${version#officier-}"

step "Проверка сервера"
[[ "$(uname -s)" == Linux ]] || fail "нужен Linux"
[[ "$(uname -m)" == x86_64 ]] || fail "нужна архитектура x86_64, здесь $(uname -m)"
command -v docker >/dev/null || fail "Docker не установлен: https://docs.docker.com/engine/install/ (Docker 24+ с Compose v2)"
docker info >/dev/null 2>&1 || fail "Docker недоступен: запустите службу docker или выполните установку через sudo"
docker compose version >/dev/null 2>&1 || fail "нет Docker Compose v2 (пакет docker-compose-plugin)"
command -v curl >/dev/null || fail "нужен curl"
command -v sha256sum >/dev/null || fail "нужен sha256sum (coreutils)"
memory_gb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
cpus=$(nproc)
docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
free_gb=$(( $(df -Pk "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}' || echo 0) / 1024 / 1024 ))
echo "Linux x86_64, $(docker --version), $(docker compose version --short 2>/dev/null || true)"
echo "память ${memory_gb} ГБ, ядер ${cpus}, свободно под Docker ${free_gb} ГБ"
(( memory_gb >= 7 )) || warn "меньше 8 ГБ памяти: одновременно на редактирование откроется ~$(( (memory_gb * 1024 * 6 / 10 - 256) / 20 )) документов"
(( cpus >= 4 )) || warn "меньше 4 ядер: открытие и сохранение документов будут медленнее"
(( free_gb >= 10 )) || fail "под Docker свободно ${free_gb} ГБ, нужно не меньше 10"

step "Проверка пакета $version"
(cd "$package" && sha256sum -c --quiet SHA256SUMS) || fail "контрольные суммы не сходятся: пакет повреждён, скачайте заново"
echo "контрольные суммы сходятся"

step "Загрузка образов"
docker load -i "$officier_tar"
docker load -i "$gateway_tar"

step "Установка в $dir"
mkdir -p "$dir"
cp "$package/deploy/compose.yaml" "$package/deploy/nginx-officier.conf" "$package/README.md" "$dir/"
mkdir -p "$dir/docs" && cp "$package"/docs/*.md "$dir/docs/"
env_file="$dir/.env"
secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
set_env() {  # set_env NAME VALUE: replace or append one line of .env
  if grep -q "^$1=" "$env_file"; then sed -i "s|^$1=.*|$1=$2|" "$env_file"; else echo "$1=$2" >> "$env_file"; fi
}
if [[ -f "$env_file" ]]; then
  echo "$env_file уже есть: секреты сохраняются, обновляются образы и указанные параметры"
else
  [[ -n "$public_url" ]] || fail "при первой установке нужен --public-url (адрес сервера документов для браузеров, https://…)"
  umask 077
  cat > "$env_file" <<EOF
# Officier $version. Created by the installer $(date -u +%Y-%m-%dT%H:%MZ). Keep this file secret.
COMPOSE_PROJECT_NAME=officier
JWT_SECRET=$(secret)
GATEWAY_API_KEY=$(secret)
EOF
  umask 022
fi
chmod 600 "$env_file"
set_env OFFICIER_IMAGE "officier:$version"
set_env OFFICIER_GATEWAY_IMAGE "officier-qms-gateway:$version"
[[ -n "$public_url" ]] && set_env OFFICIER_PUBLIC_URL "${public_url%/}"
[[ -n "$bind" ]] && set_env OFFICIER_BIND "$bind"
[[ -n "$port" ]] && set_env OFFICIER_PORT "$port"
[[ -n "$gateway_bind" ]] && set_env GATEWAY_BIND "$gateway_bind"
[[ -n "$gateway_port" ]] && set_env GATEWAY_PORT "$gateway_port"
grep -q '^OFFICIER_PUBLIC_URL=' "$env_file" || fail "в $env_file нет OFFICIER_PUBLIC_URL: укажите --public-url"
value() { grep "^$1=" "$env_file" | tail -1 | cut -d= -f2- || true; }

step "Запуск"
(cd "$dir" && docker compose up -d)

step "Проверка работы"
host_of() { if [[ -z "$1" || "$1" == 0.0.0.0 ]]; then echo 127.0.0.1; else echo "$1"; fi; }
docs_host="$(host_of "$(value OFFICIER_BIND)")"; docs_port="$(value OFFICIER_PORT)"
gateway_host="$(host_of "$(value GATEWAY_BIND)")"; gateway_port_value="$(value GATEWAY_PORT)"
docs_url="http://$docs_host:${docs_port:-8080}"
gateway_url="http://$gateway_host:${gateway_port_value:-8081}"
for i in $(seq 1 100); do
  [[ "$(curl -s --max-time 3 "$docs_url/healthcheck" || true)" == true ]] && break
  (( i == 100 )) && fail "сервер документов не ответил за 5 минут: cd $dir && docker compose logs officier"
  sleep 3
done
echo "сервер документов: $docs_url/healthcheck = true"
curl -sf --max-time 5 "$gateway_url/healthz" >/dev/null || fail "шлюз не отвечает на $gateway_url: cd $dir && docker compose logs qms-gateway"
check=$(curl -s --max-time 10 -X POST "$gateway_url/api/v1/editor-config" \
  -H "Authorization: Bearer $(value GATEWAY_API_KEY)" -H 'Content-Type: application/json' \
  -d '{"document":{"id":"install-check","versionNo":1,"revision":"1","title":"Проверка.docx","url":"https://portal.invalid/check.docx"},"user":{"id":"install","name":"Проверка установки"},"access":{"status":"ACTIVE","role":"READER"}}')
[[ "$check" == *'"token"'* && "$check" == *'"apiUrl"'* ]] || fail "шлюз не выдал подписанную конфигурацию: $check"
echo "шлюз: $gateway_url выдаёт подписанные конфигурации"
curl -sf --max-time 5 -o /dev/null "$docs_url/welcome/officier-source.tar.gz" || warn "не отдаётся /welcome/officier-source.tar.gz"

cat <<EOF

Officier $version установлен в $dir и работает.

Дальше:
  1. HTTPS: настройте прокси по образцу $dir/nginx-officier.conf на $docs_url,
     внешний адрес — $(value OFFICIER_PUBLIC_URL). Проверка: $(value OFFICIER_PUBLIC_URL)/healthcheck
  2. Портал: адрес шлюза $gateway_url, ключ — GATEWAY_API_KEY в $env_file;
     JWT_SECRET оттуда же нужен порталу для проверки callback.
     Порядок интеграции и переключения — $dir/README.md, разделы 5–7.
  3. Журналы: cd $dir && docker compose logs -f
EOF
