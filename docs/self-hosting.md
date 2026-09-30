# Self-hosting

Relay runs as one container with one persistent data volume. This guide covers a production setup behind HTTPS.

- [Requirements](#requirements)
- [Install with Docker Compose](#install-with-docker-compose)
- [Put it behind HTTPS](#put-it-behind-https)
- [Direct transfers on your network](#direct-transfers-on-your-network)
- [Nearby](#nearby)
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

The container runs as an unprivileged user with a read-only root filesystem, no Linux capabilities and `no-new-privileges`. Only the data volume persists; `/tmp` is a small memory-backed filesystem.

> [!IMPORTANT]
> Run exactly **one** Relay container per data volume. The database takes an exclusive lock, so a second process on the same volume fails at startup. That is intended, so don't add replicas.

## Put it behind HTTPS

Any reverse proxy works. It must:

1. Set `RELAY_ORIGIN=https://relay.example.com` before exposing a public hostname. Pass the original `Host` header through and serve Relay on exactly that origin. Unconfigured installations accept only localhost and literal IP addresses, preventing DNS rebinding through arbitrary hostnames.
2. Allow request bodies of at least **32 MiB**. Uploads arrive in 8 MiB chunks.
3. Not buffer responses. Live updates use Server-Sent Events, and downloads stream.
4. Send `X-Forwarded-For` and `X-Forwarded-Proto`, and be listed in `RELAY_TRUST_PROXY`. Relay takes a visitor's address only from the proxies listed there, and gives each visitor their own rate limits by it. A proxy that isn't listed counts as one visitor, and Relay says so once in its log. Never list an address that anyone else can send requests from, or a client could claim any address.

### Caddy

Caddy obtains certificates automatically:

```caddyfile
relay.example.com {
	reverse_proxy 127.0.0.1:3090
}
```

A proxy on the same host reaches Relay at `127.0.0.1:3090`. Without Docker, and on Linux with [`compose.host.yaml`](#direct-transfers-on-your-network), Relay sees it at loopback, which it trusts by default. Through Docker's published port, Relay sees it at the address of the Compose network's gateway instead, such as `172.18.0.1`. Relay logs that address the first time the proxy forwards a request; add it to `RELAY_TRUST_PROXY` in `.env`, such as `RELAY_TRUST_PROXY=172.18.0.1`. The same applies to nginx.

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

A tunnel connector, such as `cloudflared`, or a proxy in another container reaches Relay over a Docker network they share. Add these lines to `.env`, with your network and the connector's container name:

```sh
COMPOSE_FILE=compose.yaml:compose.tunnel.yaml
RELAY_TUNNEL_NETWORK=proxy
RELAY_TRUST_PROXY=cloudflared
```

Then create the network if it doesn't exist yet, and start Relay:

```sh
docker network create proxy
docker compose up -d --build
```

Attach the connector to that network and point it at `http://relay:3090`. `COMPOSE_FILE` makes every `docker compose` command include the overlay, so later updates and shutdowns need nothing extra.

`RELAY_TRUST_PROXY` takes the connector's container name, so Relay trusts it at whatever address Docker gives it, even after it's recreated, and no other container on the network. Every request through a tunnel comes from the connector, so without this, all visitors would share one set of rate limits. Relay also stays published on `127.0.0.1:3090` for this machine.

## Direct transfers on your network

When a member is on the same network as the server, their uploads and downloads can skip the internet connection and go straight to Relay, at the speed of the local network. It's on by default and needs nothing set up: no addresses, certificates, host names or apps, on the server or on devices. It keeps working when the server moves between networks.

After someone signs in, their browser tries a direct connection in the background. If it works, a **Direct** button appears in the top bar and their transfers go direct. The button switches this off, and on again, for that browser. Anywhere else the connection never works, the button never appears and nothing changes. If a direct connection drops mid-transfer, the transfer carries on the usual way from where it was.

How it works: Relay runs a helper process beside itself that accepts WebRTC connections, encrypted end to end, on UDP port `RELAY_DIRECT_PORT` (default `3090`). Relay introduces each signed-in browser to it. The browser names its own addresses, usually hidden behind random `.local` names that only devices on its network can look up, and the helper names the server's. Each side checks the other's, only ever at local network addresses, so the connection comes up only on the server's own networks. The helper passes the browser's upload chunks and file and ZIP downloads to Relay through a private socket, as the member who signed in. Nothing else travels that way, so sign-in, links, upload requests and guests always use the usual way.

- **Docker Desktop on a Mac or Windows** works as it is. Containers run in a virtual machine that other devices can't reach, so the helper makes the first contact: its checks leave through the computer like any outgoing traffic, and the browser answers them.
- **Docker Engine on Linux**: browsers reach the helper at the host's private addresses (`10.x`, `172.16–31.x`, `192.168.x` and unique local IPv6), whichever it has at the time, so Relay needs the host's network. Add `COMPOSE_FILE=compose.yaml:compose.host.yaml` to `.env` and run `docker compose up -d`. Relay then listens on the host's `127.0.0.1:3090` only, for a proxy on the same host. A tunnel connector in a container can't reach it there; run the connector on the host, or with its own host networking, pointed at `http://127.0.0.1:3090`, and leave `RELAY_TRUST_PROXY` at its default. If the host has a firewall, allow UDP `RELAY_DIRECT_PORT` from your local network; with ufw, for example, `sudo ufw allow from 192.168.1.0/24 to any port 3090 proto udp`. Don't forward it on your router.
- **Devices that can reach the server.** Guest Wi-Fi and access points with client isolation keep devices apart, and so do most VPNs; their transfers go the usual way.

**Admin → Overview** shows whether direct transfers are on and how many browsers are connected, and warns when they're unavailable, with the reason, such as the UDP port being taken by another program. Relay starts the helper again by itself if it stops. Its messages are in `docker compose logs relay`.

To turn direct transfers off for everyone, set `RELAY_DIRECT=false` in `.env` and run `docker compose up -d`.

## Nearby

**Nearby** sends files and text from one device straight to another when both are on the same network, wherever that is, such as from an iPad to an iPhone at the office while Relay runs at home. Relay only introduces the two devices, so the transfer runs at the speed of the local network, and nothing is stored on the server. It needs nothing set up on the server: no port, setting or helper.

- **Your own devices** appear whenever you're signed in on them. They can receive while Relay is open on them, and they take what you send without asking.
- **Other members** appear when both of you have Relay open on the same network and both allow it with **Visible to people nearby**, in Nearby or **Settings → Sending**. They're asked before anything arrives.
- **People without an account** join with a Nearby code or link from **Invite someone**, and give a name. They can send to and receive from your devices, and are asked before anything arrives. A code lasts an hour unless you extend it. You can remove anyone who joined, and ending the code removes everyone.

Relay judges which devices share a network by the address it sees them at: the same public IPv4 address or IPv6 /64, or its own private networks. Behind a proxy or tunnel, that means `RELAY_TRUST_PROXY` must be set as described [above](#put-it-behind-https). Otherwise every member appears to be at the proxy's address, and members elsewhere are listed for each other, although their devices never connect. The connection itself only ever uses the devices' local addresses: there are no STUN or TURN servers. Where devices can't reach each other, as on guest Wi-Fi with client isolation, Nearby says so and offers to send to your own device the usual way through Relay instead.

## Configuration

Relay reads its configuration from environment variables. With Docker Compose, set them in `.env`. Compose itself reads two more from there: `COMPOSE_FILE`, the overlays to include ([tunnel](#proxy-in-another-container) or [host network](#direct-transfers-on-your-network)), and `RELAY_TUNNEL_NETWORK`, the network the tunnel overlay joins.

| Variable            | Default         | Description                                                                                                                                                                                     |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_ORIGIN`      | none            | Pins the exact URL people open, without a trailing slash. Required for public hostnames. Unset, only localhost and literal IP hosts are accepted. Passkeys need a host name, not an IP address. |
| `RELAY_SECRET`      | generated       | Key that derives share-link and request tokens, at least 32 characters. If unset, Relay generates `<data>/secret.key`.                                                                          |
| `RELAY_SETUP_KEY`   | `false`         | `true` makes first setup ask for a one-time key from `<data>/setup.key`, so only someone with access to the server can create the administrator.                                                |
| `RELAY_DIRECT`      | `true`          | `false` turns [direct transfers](#direct-transfers-on-your-network) off.                                                                                                                        |
| `RELAY_DIRECT_PORT` | `3090`          | UDP port direct transfers use.                                                                                                                                                                  |
| `RELAY_TRUST_PROXY` | `127.0.0.1,::1` | Comma-separated proxies whose `X-Forwarded-For` Relay believes: addresses, CIDR ranges, or host names such as a connector's container name, looked up every 15 seconds.                         |
| `RELAY_DATA`        | `.data`         | Data directory. Set to `/data` in the image.                                                                                                                                                    |
| `HOST`              | `127.0.0.1`     | Listen address. Set to `0.0.0.0` in the image.                                                                                                                                                  |
| `PORT`              | `3090`          | Listen port.                                                                                                                                                                                    |

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

Or run `npm run redeploy`, which asks what to build and what to do with the data, then waits until Relay is healthy. It builds the latest commit in a clean copy of the checkout, so uncommitted changes stay out unless you choose them. It can keep the data, save a copy and start with none, delete it, or bring back a saved copy. It warns before a build whose schema would refuse the data you have, and goes back to the previous image if the new one doesn't start. `npm run redeploy -- --help` lists the options for running it without questions, such as `npm run redeploy -- -y` to build the latest commit and keep the data, and `npm run redeploy -- --rollback`.

The redeploy script supports the standard Docker-managed local data volume. It refuses data replacement for plugin-backed volumes or local volumes with driver options (including bind, NFS, CIFS and block-device mounts); use your storage provider’s backup and restore tools for those configurations. Restore sources must differ from the active volume. The script checks Docker-reported mountpoints for lexical equality and parent/child overlap; it trusts Docker-managed storage and does not resolve host symlinks or protect against concurrent external storage changes.

Relay checks both the database version and its complete schema before opening existing data. Incompatible prerelease databases are refused with an actionable error; no automatic migration or reset runs. Preserve the original directory and use its matching build to export data, or start the current build with a new empty directory.

### Backup and restore

Everything Relay stores lives in the data volume, including the database, unfinished uploads and generated secret. A backup must preserve the whole directory and any separately configured `RELAY_SECRET`.

1. Stop the service with `docker compose stop`. Do not copy a changing SQLite database or omit its WAL files.
2. Snapshot or archive the entire `relay-data` volume using your host's volume backup tool. Record the exact image/build and environment with it. Keep a separate copy before updating.
3. Restore into a **new** volume, with the same ownership and permissions, and run the matching build against that volume on a private loopback port. Never let two processes open one volume.
4. Sign in, download representative files and compare their hashes with the originals. Run **Admin → Overview → Check stored files** until the full integrity check completes. Verify shared links, member storage and a resumed upload before replacing the production volume.
5. Keep the original stopped volume until the restored instance is verified. To roll back, stop the replacement and reconnect the original volume to its matching build.

The health endpoint reports database availability and a coarse healthy/degraded status. A running process is not proof that every file is intact. Integrity checks run in the background, one at a time. Each batch admits up to 100 files, 256 MiB or 30 seconds of work, checking byte/time limits between files; one large file can exceed those soft budgets. Continue batches in Admin until the full scan completes. Healthy files remain available when another file is damaged; downloading known-damaged content fails, and uploading a valid copy repairs it. Shutdown cancels and waits for an active scan. Keep external backups: hashes detect damage but cannot reconstruct lost bytes.

The build stores Brotli and gzip copies of the web app's text files, and Relay serves whichever the browser accepts, so nothing is compressed while serving. Fingerprinted bundles cache for a year; HTML and other files revalidate. API responses, uploads, byte-range downloads and live event streams go out as they are. Relay itself compresses its large metadata responses (collections, and the lists of links, requests, deliveries and activity), and only for requests its own pages make, so another site can never measure a compressed response.

To stop Relay without touching your data, run `docker compose stop` or `docker compose down`. **Never** run `docker compose down -v`, because `-v` deletes the volumes and every file with them.

## Running without Docker

Relay needs Node.js 24 or later and a local filesystem.

```sh
npm ci
npm run build
RELAY_DATA=/var/lib/relay npm start
```

Run it under a process manager such as systemd, and give it the same reverse proxy setup as above. `npm start` serves both the API and the built web app.

[Direct transfers](#direct-transfers-on-your-network) run with it, as they do in Compose.

### Time and restored backups

Relay evaluates deadlines against the server's UTC wall clock. Keep the host synchronized with a reliable time service; browser time does not authorize access. A forward clock correction can expire or permanently purge content earlier than intended, and a backward correction can delay expiry. Once revocation, Trash or deletion is committed, setting the clock back cannot undo that state. Do not deliberately roll the server clock back to recover files. Maintenance after an outage does not add extra retention or recovery time.

Backups and downloaded copies have their own retention. Restoring an older database restores its older policy and revocation state as well; Relay cannot infer changes made after that backup. Restore while the service is inaccessible to recipients, verify the clock, review policy and revoked links/closed requests, and run cleanup before exposing the service. Apply an external backup deletion policy if retention obligations include backups.
