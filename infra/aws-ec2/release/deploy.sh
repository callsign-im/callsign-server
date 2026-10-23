#!/usr/bin/env bash
# Installs this release on the host and rolls the containers. The deploy workflow runs it through SSM:
#   deploy.sh <image>
set -euo pipefail

image="$1"
release_dir="$(cd "$(dirname "$0")" && pwd)"
app_dir=/opt/callsign

set -a
# shellcheck source=/dev/null
source /etc/callsign.env
set +a

install -m 0644 "$release_dir/compose.yaml" "$release_dir/Caddyfile" "$app_dir/"
install -m 0755 "$release_dir/backup.sh" "$app_dir/"
install -m 0644 "$release_dir/callsign-backup.service" "$release_dir/callsign-backup.timer" /etc/systemd/system/

(
  umask 077
  aws ssm get-parameter --name "$CALLSIGN_ENVIRONMENT_PARAMETER" --with-decryption \
    --query Parameter.Value --output text > "$app_dir/.env.next"
  printf "IMAGE='%s'\n" "$image" >> "$app_dir/.env.next"
  mv "$app_dir/.env.next" "$app_dir/.env"
)

aws ecr get-login-password | docker login --username AWS --password-stdin "${image%%/*}"

cd "$app_dir"
docker compose pull --quiet
docker compose up --detach --wait postgres valkey
docker compose run --rm migrate
docker compose up --detach --wait --remove-orphans

systemctl daemon-reload
systemctl enable --now callsign-backup.timer

docker image prune --all --force --filter until=168h > /dev/null
find "$app_dir/releases" -mindepth 1 -maxdepth 1 -mtime +30 -exec rm -rf {} +
