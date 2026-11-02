#!/usr/bin/env sh
# Nightly backup on the server. Add to crontab, e.g.:
#   30 2 * * * cd /opt/syndic-crm && ./deploy/backup.sh >> backups/backup.log 2>&1
# Copy the backups/ folder off the server as well (e.g. rclone to cloud storage).
set -eu
cd "$(dirname "$0")/.."
mkdir -p backups

# Consistent database snapshot (written to data/backups inside the volume).
docker compose exec -T app node server/dist/scripts/backup.js

# Encrypted document files plus the latest database snapshot.
stamp=$(date +%Y%m%d-%H%M)
tar -czf "backups/crm-$stamp.tar.gz" data/files data/backups
find backups -name 'crm-*.tar.gz' -mtime +30 -delete
echo "Backup written to backups/crm-$stamp.tar.gz"
