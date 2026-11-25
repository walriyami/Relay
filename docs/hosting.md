# Hosting

Relay runs at **https://relay.walriyami.com** on the owner's Raspberry Pi 5, managed by Walriyami Control (`walctl`), the system that builds, starts, updates and backs up every app on the owner's devices. This guide describes that setup. Follow `walctl guide` for anything about hosting on the owner's devices: never start Relay there by hand, with Docker Compose, launchd or systemd, and never set up tunnels or DNS for it.

A separate machine without Walriyami, running only Docker and a Cloudflare Tunnel, uses [`deploy/`](../deploy/README.md) instead: see [Plain Docker and a Cloudflare Tunnel](#plain-docker-and-a-cloudflare-tunnel).

- [How it runs](#how-it-runs)
- [Updating](#updating)
- [Going back to an earlier version](#going-back-to-an-earlier-version)
- [Settings](#settings)
- [Data, backups and resets](#data-backups-and-resets)
- [Logs and health](#logs-and-health)
- [Direct transfers on your network](#direct-transfers-on-your-network)
- [Nearby](#nearby)
- [First start and members](#first-start-and-members)
- [Limits and storage](#limits-and-storage)
- [Time](#time)
- [Plain Docker and a Cloudflare Tunnel](#plain-docker-and-a-cloudflare-tunnel)

## How it runs

| What                | Where it's defined                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| The app             | `relay` in [`wal.service.yaml`](../wal.service.yaml): the build inputs, port 3090, the health check `/api/health`, a 768 MB memory limit |
| The running copy    | `relay-production` in [`wal.environment.yaml`](../wal.environment.yaml): the Pi, the address and the settings                            |
| The image           | [`Dockerfile`](../Dockerfile), built for ARM64 on the Mac by walctl and uploaded to the Pi                                               |
| Everything it keeps | The `data` storage, mounted at `/data`: the database, every stored file, unfinished uploads, the generated secret and the push key pair  |

Visitors reach it through Cloudflare's tunnel and the Pi's Walriyami gateway, which provides HTTPS. Relay does its own sign-in, so the gateway lets everyone through (`publicPaths: ["/*"]`): guests and people opening shared links never see a Walriyami login.

walctl runs the container as a non-root user with Linux capabilities dropped, `no-new-privileges`, an init process and the memory limit above. Unlike a hand-made container, its root filesystem is writable and there is no process-count limit. Exactly one Relay may run per data storage: the database takes an exclusive lock, so a second copy on the same data fails at startup.

walctl reads `wal.service.yaml` only when it's registered. After changing it, run `walctl register wal.service.yaml`; after changing `wal.environment.yaml`, run `walctl environment wal.environment.yaml`.

## Updating

Production is updated from a saved commit only, never from the files on disk, which may hold someone's unfinished work:

```sh
walctl deploy relay-production --commit main
```

walctl takes a `git archive` of that commit, builds the image on the Mac, saves a snapshot of the data on the Pi, swaps versions, waits for the health check and puts the previous version back if the new one isn't healthy. Relay stops for the swap within seconds: requests still running get five seconds to finish, then their connections close. Transfers in progress pause and resume by themselves, uploads from their last saved byte and downloads from where they stopped.

Every image records the commit it holds, shown under **Admin → Overview → Server details → Version** and in `/api/health`. The image build stops with an explanation when it can't tell which commit it holds, so a plain `walctl deploy relay-production` (which builds the working tree) is refused. For a local or CI image, name the commit: `docker build --build-arg RELAY_COMMIT=$(git rev-parse HEAD) .`.

Before deploying, check that `npm run check` passes on that commit and that `npm audit --omit=dev` reports no vulnerabilities.

Relay checks the database against `server/db/schema.sql` before opening it. An update that adds to the database (a new table, column or index) is applied when Relay starts, and the log says what was added. An update that would remove or reshape stored data is refused before anything changes, with a message naming the table, so Relay doesn't start and walctl keeps the previous version running. Going back to an earlier version after an update that added to the database is refused the same way, because the earlier version doesn't know the additions.

## Going back to an earlier version

When the database layout hasn't changed, deploy the earlier commit the same way: `walctl deploy relay-production --commit <commit>`. That keeps everything people uploaded since.

`walctl rollback relay-production --confirm relay-production` also goes back, but it restores **the data** from the snapshot taken before the last deploy as well, so files, links and accounts created since then are lost. Use it only when the data itself must go back.

## Settings

Settings live in the environment's `settings` in walctl, which keeps them private: change them on the dashboard or with `walctl settings relay-production --file <settings.json>`. Secrets never go in git. `wal.environment.yaml` holds the non-secret ones.

| Variable                                                                                                                                | Production                                   | Description                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_ORIGIN`                                                                                                                          | `https://relay.walriyami.com`                | Pins the exact URL people open, without a trailing slash. Requests for other hostnames are refused. Unset, only localhost and literal IP hosts are accepted. Passkeys need a host name, not an IP address.                                                                                                                              |
| `RELAY_TRUST_PROXY`                                                                                                                     | `127.0.0.1,::1,wal-gateway`                  | Comma-separated proxies whose `X-Forwarded-For` Relay believes: addresses, CIDR ranges, or host names such as the gateway's container name, looked up every 15 seconds. Relay gives each visitor their own rate limits by that address, and Nearby uses it to tell who shares a network.                                                |
| `RELAY_CLIENT_IP_HEADER`                                                                                                                | not set                                      | A header in which a trusted proxy names the visitor, read only from proxies in `RELAY_TRUST_PROXY`. Production should set `cf-connecting-ip`: the gateway's `X-Forwarded-For` names the Cloudflare connector, the same for everyone, so without it every visitor shares one set of rate limits and Nearby sees everyone on one network. |
| `RELAY_SECRET`                                                                                                                          | generated                                    | Key that derives share-link and request tokens, at least 32 characters. If unset, Relay generates `/data/secret.key`. Moving the data to a different key keeps every file, but all existing links stop working.                                                                                                                         |
| `RELAY_SETUP_KEY`                                                                                                                       | on                                           | First setup asks for a one-time key that Relay prints in its log (`walctl logs relay-production`), or Walriyami's administrator signs in instead. `false` only on a machine nobody else can reach; ignored when `RELAY_ORIGIN` is a public name.                                                                                        |
| `RELAY_DIRECT_ADDRESSES`                                                                                                                | `192.168.1.23`                               | Comma-separated private addresses browsers are told to reach the [direct-transfer](#direct-transfers-on-your-network) helper at, for a container that can't see the host's own. Unset, the helper announces the private addresses it finds.                                                                                             |
| `RELAY_DIRECT`                                                                                                                          | on (unset)                                   | `false` turns [direct transfers](#direct-transfers-on-your-network) off. Unset, they're on.                                                                                                                                                                                                                                             |
| `RELAY_DIRECT_PORT`                                                                                                                     | unset (`3090`)                               | UDP port direct transfers use.                                                                                                                                                                                                                                                                                                          |
| `RELAY_RECOVER_ADMIN`                                                                                                                   | unset                                        | An administrator's username. At startup Relay writes a one-time link to its log that sets a new password for that account. See [Recovering administrator access](#recovering-administrator-access).                                                                                                                                     |
| `WAL_SSO_ISSUER`, `WAL_SSO_CLIENT_ID`, `WAL_SSO_CLIENT_SECRET`, `WAL_CONTROL_ORIGIN`, `WAL_CONTROL_APP_TOKEN`, `WAL_CONTROL_PROJECT_ID` | all written by `walctl sso relay-production` | Sign-in with a Walriyami account. Relay checks each person's access with Walriyami Control at `WAL_CONTROL_ORIGIN`. The first five must all be set, or Walriyami sign-in is off and only Relay's own accounts work.                                                                                                                     |

Someone signing in with Walriyami for the first time becomes an ordinary member with no limits, as with an invitation that sets none, and administrators are told and see them in Admin. A member with an existing account links it in **Settings** instead. Relay asks Control again every 10 seconds while someone uses a Walriyami session, so access removed in Walriyami ends in Relay within seconds. If Control can't be reached, people already signed in keep working for up to an hour since Control last confirmed them; after that their requests wait until Control answers again, and nobody is signed out. New Walriyami sign-ins need Control to answer, and password and passkey sign-in never depend on it.

The image itself sets `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3090` and `RELAY_DATA=/data`. Don't copy those into the environment's settings: settings win over the image, so a copy would silently pin old values after a base-image update. An invalid value stops Relay at startup with a message naming the variable.

## Data, backups and resets

Everything Relay keeps is in the `data` storage, which walctl keeps across updates and moves. walctl saves a snapshot of it before every deploy and on `walctl backup relay-production`, and `walctl restore relay-production --backup <id> --confirm relay-production` puts one back. These snapshots stay on the Pi's own disk, so they protect against a bad update, not against losing the Pi or its disk.

The storage is marked `resettable: false`: Relay holds real people's files, so walctl's reset that empties the storage leaves it alone. Never use `walctl reset` on `relay-production`. (walctl's narrower "content" reset still removes every transfer, request and file through Relay's own reset command, `server/control-reset.ts`; it's meant for test copies made with `walctl duplicate`.) After a reset, setup asks for a fresh setup key, printed in `walctl logs relay-production`; Walriyami's administrator can instead claim Relay by signing in with Walriyami.

### If the database is damaged

If the disk filled up mid-write, power was lost on a disk that ignores flushes, or the file was copied while Relay was running, Relay may stop at startup with **Relay could not start. Relay's database file … is damaged.** Stored files are separate from the database and are not touched. To recover:

1. Stop Relay and copy the whole data storage somewhere safe before trying anything.
2. With the `sqlite3` command-line tool, recover what can be read into a new file: `sqlite3 relay.sqlite ".recover" | sqlite3 recovered.sqlite`.
3. Move the damaged `relay.sqlite` (and any `relay.sqlite-wal` and `relay.sqlite-shm`) aside, rename `recovered.sqlite` to `relay.sqlite`, and start Relay. It checks the recovered file the same way.
4. Run **Admin → Overview → Server details → Check stored files** to confirm every file the database lists is present.

If recovery fails, restore the snapshot walctl took before the last deploy. That loses whatever changed since.

### Resetting content

walctl resets a stopped Relay with `node server/control-reset.ts --content`, which deletes every transfer, file, link, request, delivery, statistic and the admin history but keeps accounts, devices, invitations, every code ever given out and settings, or `--clone`, which signs everyone out and removes the keys and notification subscriptions tied to this copy's address before it runs somewhere else. The tables each clears are listed in `server/db/reset.ts`; a new table is kept until someone adds it there.

Run one Relay per data storage, and never point a test copy at production's data. `walctl duplicate relay-production --definition <test.yaml> --copy-data` makes an independent copy with its own secrets.

## Logs and health

`walctl logs relay-production` shows recent log lines. Relay logs route patterns only: never full URLs, addresses, cookies or tokens.

`/api/health` answers `{ ok, status, problems, version, commit }`. `status` is `healthy`, `degraded` or `unavailable`, and `problems` names what is wrong: `database` (a recent change couldn't be saved, or the database can't be read), `disk-space` (under 1 GiB free, or under 5% of a small disk), `stored-files` (a check found damaged files), `usage-records` (usage statistics can't be saved) and `maintenance` (a maintenance job failed or stopped running). Relay saves a tiny change at most once a minute to find out whether its disk still takes writes. Only `unavailable` (a database that can't be read or is damaged, or a missing data folder) fails the check walctl and Docker use, with a 503, since a restart is the first thing to try for those. A full disk or damaged files stay `degraded` with a 200, because restarting Relay wouldn't fix them. The container's health check prints each answer, which `docker inspect` keeps. The route is public, so it names problems without details; **Admin → Overview → Server details** explains each one.

Integrity checks run in the background, one at a time. Each batch admits up to 100 files, 256 MiB or 30 seconds of work. Continue batches in Admin until the full scan completes. Healthy files stay available when another file is damaged; downloading known-damaged content fails, and uploading a valid copy repairs it. The member who owns a damaged file sees a warning in Files and on the item, with which file it is, and **Admin → Overview → Server details** lists the affected members and how many files each has, without the file names. A hash detects damage but cannot rebuild lost bytes, so a damaged file comes back only when someone uploads it again.

The build stores Brotli and gzip copies of the web app's text files, and Relay serves whichever the browser accepts. Fingerprinted bundles cache for a year; HTML and other files revalidate. Relay itself compresses its large metadata responses, and only for requests its own pages make, so another site can never measure a compressed response.

## Direct transfers on your network

When a member is on the same network as the server, their uploads and downloads can skip the internet connection and go straight to Relay, at the speed of the local network. Nothing needs setting up on their devices: no addresses, certificates, host names or apps.

On relay.walriyami.com the Pi's home address is `192.168.1.23`. walctl publishes UDP port 3090 there and nowhere else (`runtime.lanServices` in `wal.service.yaml`), and `RELAY_DIRECT_ADDRESSES=192.168.1.23` tells browsers to reach the helper at that address. Relay itself sits on walctl's private container network, where it can see neither the Pi's address nor the hidden names browsers give themselves, so without that setting the connection would never come up. The Pi's address must stay the same, which the Pi's private DNS for the PS5 relies on too; reserve it for the Pi in the router. If it ever changes, deploys refuse the old address until `wal.service.yaml` and the setting name the new one, and meanwhile transfers go the usual way.

After someone signs in, their browser tries a direct connection in the background. If it works, a **Direct** button appears in the top bar and their transfers go direct. The button switches this off, and on again, for that browser. Anywhere the connection never works, the button never appears and nothing changes. If a direct connection drops mid-transfer, the transfer carries on the usual way from where it was.

How it works: Relay runs a helper process beside itself that accepts WebRTC connections, encrypted end to end, on UDP port `RELAY_DIRECT_PORT` (default `3090`). Relay introduces each signed-in browser to it. The browser names its own addresses, usually hidden behind random `.local` names that only devices on its network can look up, and the helper names the server's. Each side checks the other's, only ever at local network addresses, so the connection comes up only on the server's own networks. The helper passes the browser's upload chunks and file and ZIP downloads to Relay through a private socket, as the member who signed in. Nothing else travels that way, so sign-in, links, upload requests and guests always use the usual way.

What it needs from the host:

- **An address browsers can reach the helper at.** Running Relay with Node directly (`npm run dev` or `npm start`), or in a container with host networking, it announces the server's private addresses (`10.x`, `172.16–31.x`, `192.168.x` and unique local IPv6), whichever it has at the time. In a container with a published port, as walctl runs it, it can't see them: publish UDP `RELAY_DIRECT_PORT` on the server's home address, on the same port number inside and out, and set `RELAY_DIRECT_ADDRESSES` to that address. Docker Desktop on a Mac or Windows works without either, because the helper makes the first contact through the computer, which looks up the browsers' hidden names for it, unless one of Docker's own networks covers the local network's addresses (an iPhone's Personal Hotspot uses `172.20.10.x`, for example).
- **The UDP port open to the local network.** If the host has a firewall, allow UDP `RELAY_DIRECT_PORT` from the local network only; with ufw, for example, `sudo ufw allow from 192.168.1.0/24 to any port 3090 proto udp`. Don't forward it on the router.
- **Devices that can reach the server.** Guest Wi-Fi and access points with client isolation keep devices apart, and so do most VPNs; their transfers go the usual way.

**Turn it off where there is no local network.** On a server reached only through a tunnel, such as [`deploy/`](#plain-docker-and-a-cloudflare-tunnel), no member's browser shares a network with the server, so a direct connection can never come up. The helper would still start, announce Docker-internal addresses nobody can reach, and accept UDP packets from browsers, which is code running for no benefit. Set `RELAY_DIRECT=false` there; `deploy/compose.yaml` does. Elsewhere, leave it on.

**Admin → Overview** shows whether direct transfers are on and how many browsers are connected, and warns when they're unavailable, with the reason, such as the UDP port being taken by another program. Relay starts the helper again by itself if it stops.

## Nearby

**Nearby** sends files and text from one device straight to another when both are on the same network, wherever that is, such as from an iPad to an iPhone at the office. Relay only introduces the two devices, so the transfer runs at the speed of the local network, and nothing is stored on the server. It needs nothing set up on the server.

- **Your own devices** appear whenever you're signed in on them. They can receive while Relay is open on them, and they take what you send without asking. On a computer, what arrives from your own device downloads straight away. Nothing is kept on Relay, so the page asks before it's closed with something received and not yet saved. For a device that isn't open, use Send, which keeps a copy in Files and delivers it later.
- **Other members** appear when both of you have Relay open on the same network and both allow it with **Visible to people nearby**, in Nearby or **Settings → Sending**. They're asked before anything arrives.
- **People without an account** join with a Nearby code or link from **Invite someone**, and give a name. They can send to and receive from your devices, and are asked before anything arrives. A code lasts an hour unless you extend it. You can remove anyone who joined, and ending the code removes everyone.

Relay judges which devices share a network by the address it sees them at: the same public IPv4 address or IPv6 /64, or its own private networks. That depends on the gateway passing each visitor's real address on, as described for `RELAY_TRUST_PROXY` above. If every visitor arrives from the gateway's own address, every member appears to be on the same network, and members elsewhere are listed for each other, although their devices never connect. The connection itself only ever uses the devices' local addresses: there are no STUN or TURN servers. Where devices can't reach each other, as on guest Wi-Fi with client isolation, Nearby says so and offers to send to your own device through Relay instead.

## Notifications

Members turn notifications on per device in **Settings → Arrivals**. Relay sends them itself over HTTPS to the browsers' push services (Google, Mozilla, Apple and Microsoft), so the container needs outbound HTTPS, as it already has for Walriyami sign-in. In [`deploy/`](#plain-docker-and-a-cloudflare-tunnel) Relay has no direct route out; it reaches these services, and nothing else, through an allow-list proxy (Node's `NODE_USE_ENV_PROXY` with `HTTPS_PROXY`). Nothing needs configuring: Relay creates its key pair in `/data/push-keys.json` the first time a device asks. Deleting that file makes every device's subscription stale; each device then turns notifications back on itself. Apple requires the sender to name a contact address, for which Relay uses `RELAY_ORIGIN`; without an HTTPS `RELAY_ORIGIN`, iPhones and iPads may refuse notifications.

## First start and members

1. Open Relay. Setup asks for your username and password to create the administrator, and first for the setup key from `walctl logs relay-production` (or sign in with Walriyami as its administrator). Then it asks for your own choices (how long links work, how long uploads stay, how long Trash keeps things) and how much Relay may store in total, suggesting most of the free disk space.
2. Setup offers to create your first invitation. Invite more people any time from **Admin → Members**. Each invitation is a one-time link, QR code or short code.
3. Members can add a passkey in **Settings**. They can also sign in on a new device with a code shown on a device where they're already signed in.

Members choose their own settings. Administrators can give a member limits: the most storage they may use, the maximum age of their saved content including Trash, and the longest their sharing and request links work. Limits can be set on an invitation until it is used, and changed for a member at any time; tightening one shortens anything that already lasts longer. Content age begins when meaningful content is first saved, including text, an empty file or an intentionally empty folder. Each item keeps its strictest age limit: increasing a limit never extends existing content, including items still uploading. Renewal, appending and restoring cannot reset that age. Administrators can also rename members, set a new password or suspend them, and set the service capacity.

Any administrator can make another member an administrator, or take the role away again. Administrators have no limits, and can manage everyone including other administrators. Relay always keeps at least one: the last administrator's role can't be turned off.

**Remove member** in a member's **Manage** dialog deletes their account for good. The confirmation says in numbers what goes with it: their items in Files and Trash and the space that frees, their shared links and upload requests, which stop working, and the devices they're signed out of. It asks for their username before anything is deleted. A member can keep a copy first with **Download all my files**. You can't remove yourself. Someone who signs in with a Walriyami account and still has access to Relay there comes back as a new, empty account on their next sign-in, so take their access away on the People page too.

**Admin → Overview** reads top to bottom:

- **Status** says in plain words whether anything is wrong and how much space is left, and lists what needs the administrator: the disk almost full, more stored than the total storage allows, missing or damaged files, a failed or stalled cleanup, usage statistics that couldn't be saved, unused invitations, suspended members, and files that haven't been checked yet.
- **Trends**, over 7 or 30 days, 90 days or 12 months: storage over time, what was uploaded, received, downloaded and shared, whether what people did worked, and each member's share. Choosing a member's name shows their history.
- **History** lists what happened over the last 90 days, newest first: members joining, leaving, being suspended or restored, becoming or ceasing to be administrators and having their password reset; what members sent and to where, links and upload requests they created, and files guests sent them; failed sign-ins, with repeats within an hour counted on one line; and server errors and failed cleanups. It can show one kind of event or one member. It records sizes and counts, never file names, link addresses, contents or network addresses.
- **Server details** holds the file check, the running version and how the server is doing, and opens by itself when something is wrong.

A download counts when someone saves a file or a ZIP, including **Download all my files**; looking at a file in the app doesn't. Every member sees their own figures under **Usage**, and their space in **Settings → Storage**: what takes the most room, what Trash still holds with a button to empty it, and **Download all my files**, one ZIP of everything in their Files. Neither page shows file names, links or who downloaded what. However, an administrator can reset a member’s password and then sign in as them. Treat administrators and anyone with server or backup access as fully trusted.

### Recovering administrator access

If every administrator has lost their password and passkeys, nobody can reset it from inside Relay. Whoever runs the server can, with walctl:

1. Save `{"RELAY_RECOVER_ADMIN": "<username>"}` to a private file, outside git, and run `walctl settings relay-production --file <that file>`. If Relay doesn't restart by itself, run `walctl restart relay-production`.
2. Run `walctl logs relay-production`. Relay writes `Administrator recovery link for <username>, valid for 24 hours and usable once:` followed by the link.
3. Open the link and choose a new password. Saving signs that account out everywhere and removes its passkeys.
4. Set `RELAY_RECOVER_ADMIN` back to `""` the same way. Until then, each restart writes a new link, except after one was used.

The link is as powerful as the password, so don't paste the log anywhere. Only an existing administrator can be recovered this way; the setting can't create one.

## Limits and storage

| Setting            | Default                               | Where to change it                                |
| ------------------ | ------------------------------------- | ------------------------------------------------- |
| Service capacity   | Most of the free disk space           | Admin → Settings                                  |
| Member limits      | None                                  | The invitation, or the member, in Admin → Members |
| Upload retention   | Never moved to Trash                  | Each member's Settings, within their limits       |
| New link lifetime  | 7 days                                | Each member's Settings, within their limits       |
| Trash retention    | 30 days                               | Each member's Settings                            |
| Unfinished uploads | While the tab is open, then 5 minutes | Fixed                                             |

Relay stores each unique file once, identified by its SHA-256 hash. A member's storage still counts everything they saved, Trash included. Relay accepts an upload only when the member's storage limit, the service capacity and the actual free disk space all allow it. It always keeps 256 MiB of disk free. Pending uploads reserve their full declared bytes. A request-link visitor's declared bytes count against members' room on the server only as they arrive, and each visitor upload is checked again as its bytes arrive, so whoever's bytes no longer fit is the one refused. Lowering capacity or a member quota does not remove saved content or cancel accepted reservations: those uploads may finish above the new ceiling, while new positive-byte uploads are blocked. Zero-byte files and text do not consume the byte quota. Request budgets count pending bytes and saved bytes in both Files and Trash; the request owner cannot reduce a budget below that held total.

Expiry stops new access at the deadline. Maintenance moves expired content to Trash using the original expiry time, even after downtime. Trash has a fixed permanent-deletion deadline bounded by the item's maximum age. Shortening Trash retention can shorten existing deadlines; increasing it never extends them. Links pause while their item is in Trash; restoring it before the deadline makes them work again, unless they expired or were turned off. Deleting forever, emptying Trash and the automatic purge remove items at once and delete their files in the background, so other people keep working meanwhile. Physical deletion requires Relay to be running and the filesystem to allow deletion; failed blob cleanup retains durable work and retries during maintenance and startup. Admin operations report cleanup failures. Deleting one logical copy never removes a blob still referenced by another copy.

Sharing links are bounded by the current content deadline. Renewing content does not renew its links. Expired links and expired or closed upload requests cannot be revived by editing; create a new link or request. A live share includes later additions to the item. Visitor limits count admitted browsers using cookies, not people or downloads, and reducing the limit preserves browsers already admitted. Suspension temporarily blocks an owner's shares, requests and uploads. Expiry dates and the 24-hour limit on paused uploads keep running; re-enabling can restore only still-valid access and uploads. Download streams already authorized can finish after a subsequent expiry or access change.

## Time

Relay evaluates deadlines against the server's UTC wall clock, and the Pi keeps time over the network (it has no clock battery). Browser time does not authorize access. A forward clock correction can expire or permanently purge content earlier than intended, and a backward correction can delay expiry. Once revocation, Trash or deletion is committed, setting the clock back cannot undo that state.

Restoring an older snapshot restores its older policy and revocation state as well; Relay cannot infer changes made after that snapshot. Maintenance after an outage does not add extra retention or recovery time.

## Plain Docker and a Cloudflare Tunnel

[`deploy/`](../deploy) runs Relay on a machine with only Docker and a Cloudflare Tunnel, such as a test server. Its [README](../deploy/README.md) has the steps, updates and backups in plain language. Three containers run there: `relay`, `cloudflared` (the tunnel, dialling out to Cloudflare) and `egress` (a Squid proxy). The tunnel is created on the machine itself by `deploy/tunnel-setup.sh`, which signs in to Cloudflare once, keeps only the tunnel's credentials file and points `RELAY_ORIGIN`'s name at the tunnel. `cloudflared` sends every request it carries to Relay, which refuses any host name but `RELAY_ORIGIN`'s. No port is published on the machine. Relay sits on two internal Docker networks, one shared with `cloudflared` and one with `egress`, so it has no route to the internet, the host or the local network; the proxy lets it open HTTPS connections to the browsers' push services and nowhere else. Every container has a read-only root filesystem, no Linux capabilities, `no-new-privileges`, an init process, memory and process-count limits, and rotated logs. Relay's own files in the image belong to root, so even with a writable root filesystem it can write only to `/data`.

The settings `deploy/compose.yaml` gives Relay, and why:

| Variable                                        | Value                                     | Why                                                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_ORIGIN`                                  | from `.env`, the tunnel's public hostname | Required: without it every request for that name is refused.                                                                                                                                                     |
| `RELAY_TRUST_PROXY`                             | `cloudflared`                             | The tunnel container's name. Only it may report a visitor's address; other containers can't.                                                                                                                     |
| `RELAY_CLIENT_IP_HEADER`                        | `cf-connecting-ip`                        | Cloudflare writes this header itself, replacing anything the visitor sent, while `cloudflared` only appends to `X-Forwarded-For`. Each visitor gets their own rate limits, and Nearby sees who shares a network. |
| `RELAY_DIRECT`                                  | `false`                                   | No local network behind a tunnel; see [Direct transfers](#direct-transfers-on-your-network).                                                                                                                     |
| `NODE_USE_ENV_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | `1`, `http://egress:3128`, loopback       | Notifications go out through the proxy. The health check talks to `127.0.0.1` directly.                                                                                                                          |
| `RELAY_RECOVER_ADMIN`                           | from `.env`, normally empty               | [Recovering administrator access](#recovering-administrator-access).                                                                                                                                             |

Not set on purpose: `RELAY_SECRET` (Relay keeps its key in `/data/secret.key`), `RELAY_SETUP_KEY` (with a public `RELAY_ORIGIN` setup always asks for the one-time key, printed by `docker compose logs relay`) and the `WAL_*` settings, so Walriyami sign-in is off.

What walctl does that this setup doesn't: snapshots before each update and putting the previous version back when a new one fails its health check (run `deploy/backup.sh` before updating), restarting a container that is running but unhealthy (Docker restarts Relay only when it exits), and Walriyami sign-in.

There is no Cloudflare Access in front. Relay does its own sign-in, and people opening share, request and Nearby links or typing a pickup code have no account, so Access over the whole name would lock them out.

### Members who joined with Walriyami sign-in

Someone whose account was created by signing in with Walriyami never chose a Relay password: Relay gave the account a random one. Where Walriyami sign-in is off, as in `deploy/` or after moving data to a host without the `WAL_*` settings, they can't sign in, and they can't set a password themselves, because **Settings** asks for the current one. **Admin → Members** marks these members with a **Walriyami** label.

An administrator gives them a password: **Admin → Members → Manage** on that member, fill in **Set a new password**, save, and tell them the password privately. They sign in with their username and that password and can then change it in **Settings**. Setting it signs them out everywhere and removes their passkeys; passkeys belong to the web address anyway, so after a move to a new address they add new ones.

An administrator can't set their own password this way. If the administrator's own account came from Walriyami sign-in, use [`RELAY_RECOVER_ADMIN`](#recovering-administrator-access) once on the new host (in `deploy/`, through `.env`; see its README), or have another administrator set it.
