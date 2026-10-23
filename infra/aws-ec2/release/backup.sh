#!/usr/bin/env bash
# Uploads a dump of the database to S3. callsign-backup.timer runs it every hour.
set -euo pipefail

set -a
# shellcheck source=/dev/null
source /etc/callsign.env
set +a

dump=$(mktemp /var/tmp/callsign-XXXXXX.dump)
trap 'rm -f "$dump"' EXIT

cd /opt/callsign
docker compose exec -T postgres sh -c 'pg_dump --format=custom --username="$POSTGRES_USER" "$POSTGRES_DB"' > "$dump"
aws s3 cp "$dump" "s3://${CALLSIGN_BACKUP_BUCKET}/postgres/$(date -u +%Y/%m/%d/%H%M%SZ).dump" --only-show-errors
