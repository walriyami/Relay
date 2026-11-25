#!/bin/sh
# Saves everything Relay keeps (database, files, secret key) to backups/relay-<date>.tar.gz, then deletes
# all but the newest 7 (RELAY_BACKUPS_KEEP=<number> keeps another number).
# Relay stops for the copy, so the database is consistent, and starts again straight after.
# A backup is as sensitive as the server itself: anyone holding it can read every file.
#
# A failed backup says why, exits with an error and leaves backups/LAST-BACKUP-FAILED, which up.sh
# reports until a backup works again. Old backups are deleted only after a new one is saved and checked.
set -eu
cd "$(dirname "$0")"
keep=${RELAY_BACKUPS_KEEP:-7}
case "$keep" in
  "" | *[!0-9]* | 0) echo "RELAY_BACKUPS_KEEP must be a whole number of at least 1." >&2; exit 1 ;;
esac
mkdir -p backups
chmod 0700 backups
file="backups/relay-$(date +%Y-%m-%d-%H%M).tar.gz"
failed=backups/LAST-BACKUP-FAILED
started=

finish() {
  status=$?
  rm -f "$file.part"
  if [ -z "$started" ]; then docker compose start relay >/dev/null || status=1; fi
  if [ "$status" -ne 0 ]; then
    echo "$(date '+%Y-%m-%d %H:%M') Backup FAILED; no old backup was deleted. The messages above say why." >&2
    date '+%Y-%m-%d %H:%M' > "$failed"
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

echo "$(date '+%Y-%m-%d %H:%M') Backing up to $file"
docker compose stop relay
# Runs as Relay's own user inside a throwaway copy of the container, writing the archive to this shell.
# restore.sh's work folders, if one was ever left behind, aren't Relay's data.
docker compose run --rm --no-deps -T --entrypoint tar relay \
  -czf - --exclude=./.restoring --exclude=./.previous -C /data . > "$file.part"
docker compose start relay >/dev/null
started=1
# A copy that can't be read back to the end isn't a backup (a full disk cuts it short).
tar -tzf "$file.part" > /dev/null
mv "$file.part" "$file"
chmod 0600 "$file"
rm -f "$failed"
echo "Saved $file ($(du -h "$file" | cut -f1))."

# Oldest first: the names sort by date. Only this script's own dated names count, so a backup you
# renamed (relay-before-upgrade.tar.gz) is never deleted and doesn't take one of the places.
set -- backups/relay-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-[0-9][0-9][0-9][0-9].tar.gz
[ -e "$1" ] || set --
while [ "$#" -gt "$keep" ]; do
  rm -f -- "$1"
  echo "Deleted the old backup $1."
  shift
done
