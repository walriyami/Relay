# Self-hosting

Relay runs as one container with one data volume. This guide covers a production setup behind HTTPS.

- [Requirements](#requirements)
- [Install with Docker Compose](#install-with-docker-compose)
- [Put it behind HTTPS](#put-it-behind-https)
- [Configuration](#configuration)
- [First sign-in and members](#first-sign-in-and-members)
- [Limits and storage](#limits-and-storage)
- [Updating](#updating)
- [Running without Docker](#running-without-docker)

## Requirements

- A host with Docker and Docker Compose, and a **local** disk for the data volume. Relay's database needs a real local filesystem, so don't use NFS, SMB or other network storage.
- A domain name and a reverse proxy that terminates HTTPS. Browsers only allow passkeys, the clipboard and other features in secure contexts.
- Enough free space for what people will send. Relay checks real free disk space before accepting every upload.

## Install with Docker Compose

```sh
git clone https://github.com/walriyami/Relay.git relay
cd relay
cp .env.example .env
```

Edit `.env`:

```sh
RELAY_ORIGIN=https://relay.example.com
RELAY_ADMIN_PASSWORD=<a long password for the first account>
RELAY_SECRET=<output of: openssl rand -base64 48>
```

Then build and start it:

```sh
docker compose up -d --build
docker compose ps        # wait for "healthy"
```

Relay now listens on `127.0.0.1:3090`, which only this machine can reach. Put a reverse proxy in front of it to share it.

The container runs as an unprivileged user with a read-only root filesystem, no Linux capabilities and `no-new-privileges`. Only the data volume is writable.

> [!IMPORTANT]
> Run exactly **one** Relay container per data volume. The database takes an exclusive lock, so a second process on the same volume fails at startup. That is intended, so don't add replicas.

## Put it behind HTTPS

Any reverse proxy works. It must:

1. Serve Relay on the exact origin in `RELAY_ORIGIN`. Unsafe requests from any other origin are rejected.
2. Allow request bodies of at least **32 MiB**. Uploads arrive in 8 MiB chunks.
3. Not buffer responses. Live updates use Server-Sent Events, and downloads stream.
4. Send `X-Forwarded-For` from an address listed in `RELAY_TRUST_PROXY`, so rate limits see real client addresses.

### Caddy

Caddy obtains certificates automatically and needs no extra tuning:

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:3090
}
```

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name relay.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:3090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

### Proxy in another container

If your proxy runs in a container, attach Relay to the proxy's network in a `compose.override.yaml` (Compose loads it automatically) and point the proxy at `http://relay:3090`:

```yaml
services:
  relay:
    networks: [proxy]
networks:
  proxy:
    external: true
```

The default `RELAY_TRUST_PROXY` already trusts Docker's private address range (`172.16.0.0/12`). Narrow it to your proxy's subnet if other untrusted containers share that network.

Tunnels such as Cloudflare Tunnel work the same way. Route the public host name to Relay's address.

## Configuration

Relay reads its configuration from environment variables. With Docker Compose, set them in `.env`.

| Variable               | Default                 | Description                                                                                                                                        |
| ---------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_ORIGIN`         | `http://localhost:3090` | The exact URL people open, without a trailing slash. Passkeys require a host name, not an IP address.                                              |
| `RELAY_ADMIN_PASSWORD` | none                    | Password for the first account, `admin`. Only read while the database has no accounts. Required by `compose.yaml`.                                 |
| `RELAY_SECRET`         | generated               | Key that derives share-link and request tokens, at least 32 characters. If unset, Relay generates `<data>/secret.key`. Required by `compose.yaml`. |
| `RELAY_TRUST_PROXY`    | `127.0.0.1,::1`         | Comma-separated addresses or CIDR ranges of trusted proxies. `compose.yaml` adds `172.16.0.0/12`.                                                  |
| `RELAY_DATA`           | `.data`                 | Data directory. Set to `/data` in the image.                                                                                                       |
| `HOST`                 | `127.0.0.1`             | Listen address. Set to `0.0.0.0` in the image.                                                                                                     |
| `PORT`                 | `3090`                  | Listen port.                                                                                                                                       |

An invalid value stops Relay at startup with a message naming the variable.

> [!WARNING]
> Keep `RELAY_SECRET` with your data. Moving the data to a different key keeps every file, but all existing share and request links stop working.

## First sign-in and members

1. Open your origin and sign in as `admin` with `RELAY_ADMIN_PASSWORD`. Change the password in **Settings**.
2. Invite people from **Admin → Invitations**. Each invitation is a one-time link, QR code or short code.
3. Members can add a passkey in **Settings**. They can also sign in on a new device with a code shown on a device where they're already signed in.

Administrators set each member's storage quota, the service capacity and the length of short codes (four or six digits). They cannot see members' files, links or activity.

## Limits and storage

| Setting            | Default                               | Where to change it     |
| ------------------ | ------------------------------------- | ---------------------- |
| Storage per member | 100 GiB                               | Admin → Members        |
| Service capacity   | 500 GiB                               | Admin → Limits         |
| Trash retention    | 30 days                               | Fixed                  |
| New link lifetime  | 7 days                                | Each member's settings |
| Unfinished uploads | While the tab is open, then 5 minutes | Fixed                  |

Relay stores each unique file once, identified by its SHA-256 hash. Quotas still count everything a member saved. Relay accepts an upload only when the member's quota, the service capacity and the actual free disk space all allow it. It always keeps 256 MiB of disk free.

## Updating

```sh
git pull
docker compose up -d --build
```

Everything Relay stores lives in the data volume. To keep a copy before a major update, stop Relay with `docker compose stop` and copy the volume.

To stop Relay without touching your data, run `docker compose stop` or `docker compose down`. **Never** run `docker compose down -v`, because `-v` deletes the volumes and every file with them.

## Running without Docker

Relay needs Node.js 24 or later and a local filesystem.

```sh
npm ci
npm run build
RELAY_ORIGIN=https://relay.example.com \
RELAY_ADMIN_PASSWORD='a-long-first-start-password' \
RELAY_SECRET="$(openssl rand -base64 48)" \
RELAY_DATA=/var/lib/relay \
npm start
```

Run it under a process manager such as systemd, and give it the same reverse proxy setup as above. `npm start` serves both the API and the built web app.
