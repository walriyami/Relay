#!/bin/sh
# Puts a backup made by backup.sh back, replacing everything Relay holds now.
#   ./restore.sh backups/relay-2026-11-25-0300.tar.gz
set -eu
cd "$(dirname "$0")"
file="${1:?Name the backup file, for example: ./restore.sh backups/relay-2026-11-25-0300.tar.gz}"
[ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }

printf 'This replaces ALL of Relay'"'"'s current files, accounts and links with the backup. Type restore to go on: '
read -r answer
[ "$answer" = restore ] || { echo "Nothing changed."; exit 1; }

docker compose stop relay
trap 'docker compose start relay >/dev/null' EXIT
docker compose run --rm --no-deps -T --entrypoint sh relay \
  -c 'find /data -mindepth 1 -delete && tar -xzf - -C /data' < "$file"
echo "Restored $file."
