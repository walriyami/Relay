#!/bin/sh
# One-time: creates this machine's Cloudflare Tunnel and points RELAY_ORIGIN's name (from .env) at it.
# cloudflared runs in Docker; its files stay in secrets/. Safe to run again: it skips what is done.
set -eu
cd "$(dirname "$0")"

image=$(sed -n 's/^ *image: *\(cloudflare\/cloudflared:[^ ]*\).*$/\1/p' compose.yaml)
[ -f .env ] || { echo "Copy example.env to .env and set RELAY_ORIGIN first (README.md)." >&2; exit 1; }
origin=$(sed -n 's/^RELAY_ORIGIN=//p' .env | tr -d "\"' \r")
host=${origin#https://}
case "$origin" in
  https://*) ;;
  *) echo "RELAY_ORIGIN in .env must start with https://" >&2; exit 1 ;;
esac
case "$host" in
  "" | */* | *:*) echo "RELAY_ORIGIN in .env must be https:// and a name only, such as https://buildhatch.dev" >&2; exit 1 ;;
esac

mkdir -p secrets
chmod 700 secrets
# cloudflared's own commands, as you, with its files in secrets/.
cf() {
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/home/cf -w /home/cf/.cloudflared \
    -v "$PWD/secrets:/home/cf/.cloudflared" "$image" "$@"
}

if [ ! -f secrets/cert.pem ]; then
  echo "A Cloudflare link appears below. Open it in a browser, sign in, and choose $host."
  cf tunnel login
fi
creds=secrets/tunnel_credentials.json
if [ ! -f "$creds" ]; then
  cf tunnel create --credentials-file /home/cf/.cloudflared/tunnel_credentials.json "relay-$host"
fi
if [ -r "$creds" ]; then
  id=$(sed -n 's/.*"TunnelID" *: *"\([0-9a-f-]*\)".*/\1/p' "$creds")
else
  # Already handed to cloudflared on an earlier run (below), so only it can read the key: the ID is in .env.
  id=$(sed -n 's/^TUNNEL_ID=//p' .env | tr -d "\"' \r")
fi
case "$id" in *[!0-9a-f-]*) id= ;; esac
[ -n "$id" ] || { echo "$creds doesn't name a tunnel, and TUNNEL_ID in .env is empty." >&2; exit 1; }

echo "Pointing $host at the tunnel (this replaces any other DNS record for $host)."
cf tunnel route dns --overwrite-dns "$id" "$host"

# cert.pem can create and delete tunnels and DNS records for your domain. Running needs only the
# tunnel's credentials, so it isn't kept. Running this script again asks you to sign in again.
rm -f secrets/cert.pem

if grep -q '^TUNNEL_ID=' .env; then
  sed "s/^TUNNEL_ID=.*/TUNNEL_ID=$id/" .env > .env.new && mv .env.new .env
else
  printf 'TUNNEL_ID=%s\n' "$id" >> .env
fi
chmod 600 .env

# The tunnel key becomes readable by cloudflared's own user inside Docker (65532) and nobody else: not
# Relay, not other accounts on this machine, not your own. Only root can hand a file to another user.
if [ -O "$creds" ]; then
  chmod 400 "$creds"
  echo "Handing the tunnel key to cloudflared (sudo may ask for your password)."
  sudo chown 65532:65532 "$creds"
fi
echo "Tunnel ready: $host -> tunnel $id. Next: ./up.sh"
