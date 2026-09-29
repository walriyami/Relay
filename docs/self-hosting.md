# Self-hosting

Relay's Compose stack runs the app, a bundled gateway and a helper for [direct transfers](#direct-transfers-on-your-network), with one persistent data volume for the app. This guide covers a production setup behind HTTPS.

- [Requirements](#requirements)
- [Install with Docker Compose](#install-with-docker-compose)
- [Put it behind HTTPS](#put-it-behind-https)
- [Direct transfers on your network](#direct-transfers-on-your-network)
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
docker compose up -d --build
docker compose ps        # wait for "healthy"
```

Localhost setup needs no environment settings. Public hostname use requires an HTTPS `RELAY_ORIGIN`; copy `.env.example` to `.env` and configure it before exposing Relay.

Relay now listens on `127.0.0.1:3090`, which only this machine can reach. Put a reverse proxy in front of it to share it.

> [!IMPORTANT]
> Until the administrator exists, whoever opens Relay first creates it. If others can reach the server before you do, set `RELAY_SETUP_KEY=true`: setup then also asks for a one-time key from the server. Run `docker compose exec relay cat /data/setup.key`, or for a direct Node installation read `<RELAY_DATA>/setup.key` (default `.data/setup.key`). The key survives restarts until the administrator is created and is then deleted. Keep it private. Existing installations never ask for it. For remote local setup, use `ssh -L 3090:localhost:3090 your-server`, then open http://localhost:3090.

All three containers run as unprivileged users with read-only root filesystems and `no-new-privileges`. The app and the helper drop all Linux capabilities; the gateway retains only `NET_BIND_SERVICE`, required by its Caddy binary. The app's data volume is persistent; temporary writable directories use bounded memory-backed filesystems.

> [!IMPORTANT]
> Run exactly **one** Relay container per data volume. The database takes an exclusive lock, so a second process on the same volume fails at startup. That is intended, so don't add replicas.

## Put it behind HTTPS

Any reverse proxy works. It must:

1. Set `RELAY_ORIGIN=https://relay.example.com` before exposing a public hostname. Pass the original `Host` header through and serve Relay on exactly that origin. Unconfigured installations accept only localhost and literal IP addresses, preventing DNS rebinding through arbitrary hostnames.
2. Allow request bodies of at least **32 MiB**. Uploads arrive in 8 MiB chunks.
3. Not buffer responses. Live updates use Server-Sent Events, and downloads stream.
4. Send `X-Forwarded-For` and `X-Forwarded-Proto` from an address listed in `RELAY_TRUST_PROXY`. The trusted edge must replace untrusted forwarded headers, and each subsequent trusted hop must preserve the verified client chain. Otherwise unrelated visitors may share a rate-limit bucket, or a client could spoof its address.

### Caddy

Caddy obtains certificates automatically:

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:3090
}
```

For the Compose stack, also configure the host proxy's actual source address in `RELAY_CADDY_TRUSTED_PROXIES`. Docker usually presents a host proxy connecting through the published port as the bridge gateway (for example `172.31.247.1` on the default Linux subnet), not loopback. Confirm the address on your host before trusting it; Docker Desktop and custom networks can differ. Trust only that controlled proxy hop, keep port 3090 private, and verify that two external clients retain distinct addresses through the full chain. This applies to host nginx as well. Direct Node deployments normally see a host proxy on loopback.

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

The default Compose configuration creates its own backend network and publishes only the gateway on loopback. It needs no pre-existing network. For a proxy or tunnel in another container, use the optional overlay:

```sh
# Use the name of the network shared with your trusted connector.
export RELAY_TUNNEL_NETWORK=streaming_lab_private
docker network create "$RELAY_TUNNEL_NETWORK"  # once, if it does not exist
docker compose -f compose.yaml -f compose.tunnel.yaml up -d --build
```

Attach the connector to that network and point it at `http://relay:3090`. The `relay` alias belongs to the stable gateway. Set `RELAY_CADDY_TRUSTED_PROXIES` to the connector's actual stable addresses. Include both Compose files on later updates and shutdowns, or copy the overlay to `compose.override.yaml` to load it automatically.

Direct Node deployments trust loopback by default. Compose additionally trusts the bundled gateway at its dedicated `RELAY_GATEWAY_IP`. Set any additional `RELAY_TRUST_PROXY` entries to actual proxy addresses only. Do not trust the entire Docker private range or a network with untrusted containers. The dedicated Compose subnet and gateway address can be changed together if they overlap an existing network.

For a tunnel plus gateway, set `RELAY_CADDY_TRUSTED_PROXIES` to the space-separated addresses/CIDRs of the trusted connector chain. Caddy uses strict forwarded-address parsing, rejects untrusted forwarded addresses, and sends the verified client address to Relay. Relay trusts only the gateway for this handoff. Keep the app port private; never trust a header just because its name is `CF-Connecting-IP` or `X-Forwarded-For`. Verify distinct client addresses on a disposable instance before relying on per-IP limits.

## Direct transfers on your network

When a member is on the same network as the server, their uploads and downloads can skip the internet connection and go straight to Relay, at the speed of the local network. The Compose stack includes this as the `relay-local` container. Devices need nothing set up: no certificates, host names or apps.

After someone signs in, their browser tries a direct connection in the background. If it works, a **Direct** button appears in the top bar and their transfers go direct. The button switches this off, and on again, for that browser. Anywhere else the connection never works, the button never appears and nothing changes. If a direct connection drops mid-transfer, the transfer carries on the usual way from where it was.

How it works: `relay-local` runs on the host's own network and listens on UDP port `RELAY_LOCAL_PORT` (default `3090`). Relay introduces each signed-in browser to it, and the browser connects with WebRTC, encrypted end to end between the two. The helper passes the browser's upload chunks and file and ZIP downloads to Relay through a private socket in the `relay-local` volume, as the member who signed in. Nothing else travels that way, so sign-in, links, upload requests and guests always use the usual way.

Requirements:

- **Linux with Docker Engine.** The helper uses the host's network (`network_mode: host`). Docker Desktop on macOS and Windows runs containers in a virtual machine that other devices can't reach, so there direct transfers stay unavailable and everything works as before.
- **UDP `RELAY_LOCAL_PORT` open to your local network** in the host's firewall. With ufw, for example, `sudo ufw allow from 192.168.1.0/24 to any port 3090 proto udp`. Don't forward it on your router; only devices on your own network need it.
- **Devices that can reach the host.** Guest Wi-Fi and access points with client isolation keep devices apart, and so do most VPNs; their transfers go the usual way.

The helper tells browsers to reach it at the host's private addresses (`10.x`, `172.16–31.x`, `192.168.x` and unique local IPv6), skipping Docker and virtual machine bridges. If those include addresses your devices can't reach, list the right ones in `RELAY_LOCAL_ADDRESSES`.

**Admin → Overview** shows where direct transfers are offered and how many browsers are connected, and warns when the helper stops answering. Its log is `docker compose logs relay-local`.

To turn direct transfers off for everyone, add this to `compose.override.yaml`, then run `docker compose up -d` and `docker compose rm -sf relay-local`:

```yaml
services:
  relay:
    environment:
      RELAY_LOCAL: ""
  relay-local:
    profiles: [off]
```

## Configuration

Relay reads its configuration from environment variables. With Docker Compose, set them in `.env`.

| Variable                      | Default           | Description                                                                                                                                                                                     |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_ORIGIN`                | none              | Pins the exact URL people open, without a trailing slash. Required for public hostnames. Unset, only localhost and literal IP hosts are accepted. Passkeys need a host name, not an IP address. |
| `RELAY_SECRET`                | generated         | Key that derives share-link and request tokens, at least 32 characters. If unset, Relay generates `<data>/secret.key`.                                                                          |
| `RELAY_SETUP_KEY`             | `false`           | `true` makes first setup ask for a one-time key from `<data>/setup.key`, so only someone with access to the server can create the administrator.                                                |
| `RELAY_TRUST_PROXY`           | `127.0.0.1,::1`   | Comma-separated addresses or CIDR ranges of trusted proxies. Compose additionally trusts its dedicated gateway IP. Configure only actual additional proxy addresses.                            |
| `RELAY_BACKEND_SUBNET`        | `172.31.247.0/29` | Compose private backend subnet. Change together with the gateway address if it overlaps another network.                                                                                        |
| `RELAY_GATEWAY_IP`            | `172.31.247.2`    | Gateway address on that subnet, automatically trusted by the Relay container.                                                                                                                   |
| `RELAY_CADDY_TRUSTED_PROXIES` | `127.0.0.1 ::1`   | Space-separated upstream proxy addresses/CIDRs Caddy trusts to report client addresses. Configure the actual connector chain for public deployments.                                            |
| `RELAY_DATA`                  | `.data`           | Data directory. Set to `/data` in the image.                                                                                                                                                    |
| `HOST`                        | `127.0.0.1`       | Listen address. Set to `0.0.0.0` in the image.                                                                                                                                                  |
| `PORT`                        | `3090`            | Listen port.                                                                                                                                                                                    |
| `RELAY_LOCAL`                 | none              | Directory shared with the `relay-local` helper, which offers direct transfers. Unset, there are none. Compose sets it for both.                                                                 |
| `RELAY_LOCAL_PORT`            | `3090`            | UDP port the helper listens on for direct connections.                                                                                                                                          |
| `RELAY_LOCAL_ADDRESSES`       | host's private    | Comma-separated IP addresses browsers are told to reach the helper at, instead of the host's private addresses.                                                                                 |

An invalid value stops Relay at startup with a message naming the variable.

> [!WARNING]
> Keep `RELAY_SECRET` with your data. Moving the data to a different key keeps every file, but all existing share and request links stop working.

## First start and members

1. Open Relay. Setup asks for your username and password to create the administrator, and first for the setup key if you set `RELAY_SETUP_KEY=true`. Then it asks for your own choices (how long links work, how long uploads stay, how long Trash keeps things) and how much Relay may store in total, suggesting most of the free disk space.
2. Setup offers to create your first invitation. Invite more people any time from **Admin → Members**. Each invitation is a one-time link, QR code or short code.
3. Members can add a passkey in **Settings**. They can also sign in on a new device with a code shown on a device where they're already signed in.

Members choose their own settings. Administrators can give a member limits: the most storage they may use, the maximum age of their saved content including Trash, and the longest their sharing and request links work. Limits can be set on an invitation until it is used, and changed for a member at any time; tightening one shortens anything that already lasts longer. Content age begins when meaningful content is first saved, including text, an empty file or an intentionally empty folder. Each item keeps its strictest age limit: increasing a limit never extends existing content, including items still uploading. Renewal, appending and restoring cannot reset that age. Administrators can also rename members, set a new password or suspend them, and set the service capacity and the length of short codes (four or six digits).

**Admin → Overview** shows storage, data moved, files added and requests served, over days or months, and how much each member stores and moves. Every member sees their own under **Usage**. Neither shows file names, links or who downloaded what. However, an administrator can reset a member’s password and then sign in as them. Treat administrators and anyone with server or backup access as fully trusted.

## Limits and storage

| Setting            | Default                               | Where to change it                                |
| ------------------ | ------------------------------------- | ------------------------------------------------- |
| Service capacity   | Most of the free disk space           | Admin → Settings                                  |
| Member limits      | None                                  | The invitation, or the member, in Admin → Members |
| Upload retention   | Never moved to Trash                  | Each member's Settings, within their limits       |
| New link lifetime  | 7 days                                | Each member's Settings, within their limits       |
| Trash retention    | 30 days                               | Each member's Settings                            |
| Unfinished uploads | While the tab is open, then 5 minutes | Fixed                                             |

Relay stores each unique file once, identified by its SHA-256 hash. A member's storage still counts everything they saved, Trash included. Relay accepts an upload only when the member's storage limit, the service capacity and the actual free disk space all allow it. It always keeps 256 MiB of disk free. Pending uploads reserve their full declared bytes. Lowering capacity or a member quota does not remove saved content or cancel accepted reservations: those uploads may finish above the new ceiling, while new positive-byte uploads are blocked. Zero-byte files and text do not consume the byte quota. Request budgets count pending bytes and saved bytes in both Files and Trash; the request owner cannot reduce a budget below that held total.

Expiry stops new access at the deadline. Maintenance moves expired content to Trash using the original expiry time, even after downtime. Trash has a fixed permanent-deletion deadline bounded by the item's maximum age. Shortening Trash retention can shorten existing deadlines; increasing it never extends them. Restoring before the deadline leaves old links revoked. Physical deletion requires Relay to be running and the filesystem to allow deletion; failed blob cleanup retains durable work and retries during maintenance and startup. Admin operations report cleanup failures. Deleting one logical copy never removes a blob still referenced by another copy.

Sharing links are bounded by the current content deadline. Renewing content does not renew its links. Expired links and expired or closed upload requests cannot be revived by editing; create a new link or request. A live share includes later additions to the item. Visitor limits count admitted browsers using cookies, not people or downloads, and reducing the limit preserves browsers already admitted. Suspension temporarily blocks an owner's shares, requests and uploads. Expiry dates and the five-minute upload inactivity lease keep running; re-enabling can restore only still-valid access and uploads. Download streams already authorized can finish after a subsequent expiry or access change.

## Updating

```sh
git pull
docker compose up -d --build
```

Relay checks both the database version and its complete schema before opening existing data. Incompatible prerelease databases are refused with an actionable error; no automatic migration or reset runs. Preserve the original directory and use its matching build to export data, or start the current build with a new empty directory.

### Backup and restore

Everything Relay stores lives in the data volume, including the database, unfinished uploads and generated secret. A backup must preserve the whole directory and any separately configured `RELAY_SECRET`.

1. Stop the service with `docker compose stop` (include the overlay if used). Do not copy a changing SQLite database or omit its WAL files.
2. Snapshot or archive the entire `relay-data` volume using your host's volume backup tool. Record the exact image/build and environment with it. Keep a separate copy before updating.
3. Restore into a **new** volume, with the same ownership and permissions, and run the matching build against that volume on a private loopback port. Never let two processes open one volume.
4. Sign in, download representative files and compare their hashes with the originals. Run **Admin → Overview → Check stored files** until the full integrity check completes. Verify shared links, member storage and a resumed upload before replacing the production volume.
5. Keep the original stopped volume until the restored instance is verified. To roll back, stop the replacement and reconnect the original volume to its matching build.

The health endpoint reports database availability and a coarse healthy/degraded status. A running process is not proof that every file is intact. Integrity checks run in the background, one at a time. Each batch admits up to 100 files, 256 MiB or 30 seconds of work, checking byte/time limits between files; one large file can exceed those soft budgets. Continue batches in Admin until the full scan completes. Healthy files remain available when another file is damaged; downloading known-damaged content fails, and uploading a valid copy repairs it. Shutdown cancels and waits for an active scan. Keep external backups: hashes detect damage but cannot reconstruct lost bytes.

The bundled gateway compresses app text assets. Fingerprinted bundles cache immutably for a year; HTML and unversioned files revalidate. The gateway passes API responses, uploads, byte-range downloads and live event streams through unchanged. Relay itself compresses its large metadata responses (collections, and the lists of links, requests, deliveries and activity), and only for requests its own pages make, so another site can never measure a compressed response.

To stop Relay without touching your data, run `docker compose stop` or `docker compose down`. **Never** run `docker compose down -v`, because `-v` deletes the volumes and every file with them.

## Running without Docker

Relay needs Node.js 24 or later and a local filesystem.

```sh
npm ci
npm run build
RELAY_DATA=/var/lib/relay npm start
```

Run it under a process manager such as systemd, and give it the same reverse proxy setup as above. `npm start` serves both the API and the built web app.

For [direct transfers](#direct-transfers-on-your-network), also run the helper as a second service, with the same `RELAY_LOCAL` directory for both:

```sh
RELAY_LOCAL=/run/relay-local RELAY_DATA=/var/lib/relay npm start
RELAY_LOCAL=/run/relay-local node local/main.ts
```

### Time and restored backups

Relay evaluates deadlines against the server's UTC wall clock. Keep the host synchronized with a reliable time service; browser time does not authorize access. A forward clock correction can expire or permanently purge content earlier than intended, and a backward correction can delay expiry. Once revocation, Trash or deletion is committed, setting the clock back cannot undo that state. Do not deliberately roll the server clock back to recover files. Maintenance after an outage does not add extra retention or recovery time.

Backups and downloaded copies have their own retention. Restoring an older database restores its older policy and revocation state as well; Relay cannot infer changes made after that backup. Restore while the service is inaccessible to recipients, verify the clock, review policy and revoked links/closed requests, and run cleanup before exposing the service. Apply an external backup deletion policy if retention obligations include backups.
