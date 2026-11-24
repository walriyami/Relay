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
if [ ! -f secrets/tunnel_credentials.json ]; then
  cf tunnel create --credentials-file /home/cf/.cloudflared/tunnel_credentials.json "relay-$host"
fi
id=$(sed -n 's/.*"TunnelID" *: *"\([0-9a-f-]*\)".*/\1/p' secrets/tunnel_credentials.json)
[ -n "$id" ] || { echo "secrets/tunnel_credentials.json doesn't name a tunnel." >&2; exit 1; }

echo "Pointing $host at the tunnel (this replaces any other DNS record for $host)."
cf tunnel route dns --overwrite-dns "$id" "$host"

# cloudflared's own user inside Docker must be able to read it; the secrets folder stays yours alone.
chmod 444 secrets/tunnel_credentials.json
# cert.pem can create and delete tunnels and DNS records for your domain. Running needs only the
# tunnel's credentials, so it isn't kept. Running this script again asks you to sign in again.
rm -f secrets/cert.pem

if grep -q '^TUNNEL_ID=' .env; then
  sed "s/^TUNNEL_ID=.*/TUNNEL_ID=$id/" .env > .env.new && mv .env.new .env
else
  printf 'TUNNEL_ID=%s\n' "$id" >> .env
fi
chmod 600 .env
echo "Tunnel ready: $host -> tunnel $id. Next: ./up.sh"
