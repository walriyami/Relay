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
# Inside a throwaway copy of the container, as Relay's own user: unpack into /data/.restoring. Only when
# that worked, move the current data aside into /data/.previous, move the backup in, and delete the old
# data last. Moving within /data takes no space, so a full disk or a cut-off file stops before anything
# is lost, and a failure while swapping puts the old data back.
docker compose run --rm --no-deps -T --entrypoint sh relay -c '
  set -eu
  # Moves everything in $1 except the two work folders into $2.
  move() {
    for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
      [ -e "$entry" ] || [ -L "$entry" ] || continue
      case "${entry##*/}" in .restoring | .previous) continue ;; esac
      mv "$entry" "$2"/ || return 1
    done
  }
  failed() {
    echo "$1 Relay still has its data from before." >&2
    exit 1
  }
  rm -rf /data/.restoring /data/.previous
  mkdir /data/.restoring /data/.previous
  if ! tar -xzf - -C /data/.restoring --exclude=./.restoring --exclude=./.previous ||
    [ ! -f /data/.restoring/relay.sqlite ]; then
    rm -rf /data/.restoring
    rmdir /data/.previous
    failed "The backup could not be unpacked (is the disk full?)."
  fi
  if ! move /data /data/.previous; then
    move /data/.previous /data || true
    rm -rf /data/.restoring
    rmdir /data/.previous || true
    failed "The backup could not be put in place."
  fi
  if ! move /data/.restoring /data; then
    move /data /data/.restoring || true
    move /data/.previous /data || true
    rm -rf /data/.restoring
    rmdir /data/.previous || true
    failed "The backup could not be put in place."
  fi
  rmdir /data/.restoring
  rm -rf /data/.previous
' < "$file"
echo "Restored $file."
