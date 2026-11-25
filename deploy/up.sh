#!/bin/sh
# Builds Relay from the commit this folder is checked out at and starts (or restarts) everything.
# Used for the first start and after every `git pull`. Data in the relay-data volume is kept.
set -eu
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "Missing deploy/.env. Copy example.env to .env and set RELAY_ORIGIN first." >&2
  exit 1
fi
if [ ! -s secrets/tunnel_credentials.json ] || ! grep -q '^TUNNEL_ID=..*' .env; then
  echo "The Cloudflare Tunnel isn't set up yet. Run ./tunnel-setup.sh first (README.md, step 4)." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no -- ..)" ]; then
  echo "Relay's files were changed on this machine (git status shows what). Undo that before building," >&2
  echo "so the running copy is exactly the commit it reports." >&2
  exit 1
fi
if [ -f backups/LAST-BACKUP-FAILED ]; then
  echo "Warning: the last backup, on $(cat backups/LAST-BACKUP-FAILED), failed. Run ./backup.sh to see why." >&2
fi

RELAY_COMMIT="$(git rev-parse HEAD)"
export RELAY_COMMIT
# The image is built from a copy of exactly this commit, made by git: files that aren't part of it
# (anything new or ignored in this folder) can't reach the image.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
git -C "$(git rev-parse --show-toplevel)" archive --format=tar --output="$work/relay.tar" "$RELAY_COMMIT"
mkdir "$work/relay"
tar -xf "$work/relay.tar" -C "$work/relay"
rm "$work/relay.tar"
RELAY_BUILD_CONTEXT="$work/relay"
export RELAY_BUILD_CONTEXT
echo "Building Relay $(git log -1 --format='%h (%cs) %s')"
old=$(docker image inspect -f '{{.Id}}' relay:local 2>/dev/null || true)
if ! docker compose up -d --build --wait --wait-timeout 180; then
  docker compose ps >&2
  echo "Something above isn't healthy. Its last messages:  docker compose logs --tail 50 <name>" >&2
  exit 1
fi
# Remove the copy of Relay this build replaced, and only that: other images on the machine are left alone.
new=$(docker image inspect -f '{{.Id}}' relay:local)
if [ -n "$old" ] && [ "$old" != "$new" ]; then
  docker image rm "$old" >/dev/null 2>&1 || true
fi
docker compose ps
echo "Relay is up."
