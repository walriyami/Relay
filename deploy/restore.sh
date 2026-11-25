#!/bin/sh
# Puts a backup made by backup.sh back, replacing everything Relay holds now.
#   ./restore.sh backups/relay-2026-11-25-0300.tar.gz
# The backup is checked first and unpacked next to the current data; only when that worked is the
# current data replaced. A damaged or wrong file leaves Relay as it was.
set -eu
cd "$(dirname "$0")"
file="${1:?Name the backup file, for example: ./restore.sh backups/relay-2026-11-25-0300.tar.gz}"
[ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }

echo "Checking $file..."
listing=$(mktemp)
trap 'rm -f "$listing"' EXIT
if ! tar -tzf "$file" > "$listing" 2>/dev/null; then
  echo "$file is damaged or isn't a backup (it can't be read to the end). Nothing changed." >&2
  exit 1
fi
if ! grep -qx '\./relay\.sqlite' "$listing"; then
  echo "$file doesn't hold Relay's database, so it isn't a Relay backup. Nothing changed." >&2
  exit 1
fi
rm -f "$listing"
trap - EXIT

printf 'This replaces ALL of Relay'"'"'s current files, accounts and links with the backup. Type restore to go on: '
read -r answer
[ "$answer" = restore ] || { echo "Nothing changed."; exit 1; }

docker compose stop relay
trap 'docker compose start relay >/dev/null' EXIT
trap 'exit 1' HUP INT TERM
# Inside a throwaway copy of the container, as Relay's own user: unpack into /data/.restoring, and only
# when that succeeded swap it in. A full disk or a cut-off file stops before anything is deleted.
docker compose run --rm --no-deps -T --entrypoint sh relay -c '
  set -eu
  rm -rf /data/.restoring
  mkdir /data/.restoring
  if ! tar -xzf - -C /data/.restoring || [ ! -f /data/.restoring/relay.sqlite ]; then
    rm -rf /data/.restoring
    echo "The backup could not be unpacked (is the disk full?). Relay still has its data from before." >&2
    exit 1
  fi
  find /data -mindepth 1 -maxdepth 1 ! -name .restoring -exec rm -rf {} +
  find /data/.restoring -mindepth 1 -maxdepth 1 -exec mv {} /data/ \;
  rmdir /data/.restoring
' < "$file"
echo "Restored $file."
