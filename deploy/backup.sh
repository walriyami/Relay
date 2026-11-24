#!/bin/sh
# Saves everything Relay keeps (database, files, secret key) to backups/relay-<date>.tar.gz.
# Relay stops for the copy, so the database is consistent, and starts again straight after.
# A backup is as sensitive as the server itself: anyone holding it can read every file.
set -eu
cd "$(dirname "$0")"
mkdir -p backups
chmod 0700 backups
file="backups/relay-$(date +%Y-%m-%d-%H%M).tar.gz"

docker compose stop relay
trap 'docker compose start relay >/dev/null' EXIT
# Runs as Relay's own user inside a throwaway copy of the container, writing the archive to this shell.
docker compose run --rm --no-deps -T --entrypoint tar relay -czf - -C /data . > "$file.part"
mv "$file.part" "$file"
chmod 0600 "$file"
echo "Saved $file ($(du -h "$file" | cut -f1))."
