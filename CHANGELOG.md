# Changelog

All notable changes to Relay are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First-start setup in the browser: create the administrator account, choose what everyone gets, and invite your first person. Relay needs no settings to start.
- Per-member settings. Each member has their own storage, upload retention, link lifetime and Trash retention. Setup chooses what new members start with, and **Admin → New members** changes it later.
- Administrators can change a member's name, username, link lifetime and Trash retention.
- Members choose how long Trash keeps what they delete, in **Settings → Storage**.
- Direct transfers. On the server's own network, members' uploads and downloads go straight to Relay over WebRTC instead of the internet connection, with nothing to set up on their devices. A **Direct** button in the top bar shows when this is on and switches it off. It's on by default and needs no configuration: Relay runs the helper itself, and the connection comes up without any address being set, including on Docker Desktop and when the server changes networks. They need Relay on the host's network with its UDP port reachable, so they're off on relay.walriyami.com until its hosting allows that. See [Hosting](docs/hosting.md#direct-transfers-on-your-network).
- Nearby, a tab of its own for sending files and text straight from one device to another on the same network, without going through Relay or into Files. Your own signed-in devices always appear and take what you send without asking. Other members appear on the same network, must accept, and can hide themselves with **Visible to people nearby**. Someone without an account joins with a Nearby code or link. Received photos save to the photo library through the share sheet on phones and tablets, and computers download files or one ZIP. Transfers pick up where they left off if the connection drops. When your own device can't be reached directly, **Send via Relay** sends the same files the usual way. See [Hosting](docs/hosting.md#nearby).
- Direct transfers and Nearby spread their bytes over several WebRTC connections at once, since a browser lets each connection carry only a few megabits a second over Wi-Fi.

- Relay installs as an app on phones and computers, opening in its own window, and appears in the share sheet: files, text and links shared to it land in the Send draft. On iPhone, a Shortcut can send text and links. See [On your phone](README.md#on-your-phone).
- Notifications on each device, even with Relay closed, when something arrives for that device, someone sends files to your request, or a link is first downloaded. They're off until turned on in **Settings → Arrivals**; on iPhone and iPad they need Relay added to the Home Screen.
- A **Share…** button for links on phones, and received photos and videos save to Photos through the share sheet.

- `RELAY_TRUST_PROXY` accepts host names, such as a tunnel connector's container name, which Relay follows as Docker readdresses it.
- The web app's text files are Brotli- and gzip-compressed at build time and served precompressed.

### Changed

- The Activity bell counts only news: sign-ins on a kind of device you already use and links that were only opened no longer light it up. A sign-in on a new kind of device says so and links to your devices.
- Editing `server/db/schema.sql` no longer locks Relay out of existing data. At startup Relay adds new tables, columns and indexes itself, ignores comments and formatting, and refuses only an edit that would remove or reshape stored data, with a message naming it. The one-off upgrade from the first schema is gone.
- A damaged database stops Relay at startup with a plain explanation and recovery steps instead of a stack trace. Startup errors Relay understands are printed the same way.
- The health check reports what is wrong instead of always answering "ok": it names problems (`database`, `disk-space`, `stored-files`, `usage-records`, `maintenance`), notices a disk that stops taking writes, and fails with a 503 only when the database can't be read or is damaged. **Admin → Overview → Service health** says when the database couldn't save a change.
- `control-reset --content` keeps invitations' codes and every code ever given out, so a printed code is never reused. The tables each reset clears are listed explicitly; a new table is kept until someone decides otherwise.

- Relay runs as one container. The Caddy gateway, its Unix socket and `RELAY_SOCKET` are gone: Relay serves HTTP itself on port 3090.
- Relay is hosted with walctl, which builds, runs, health-checks and rolls back the container. [Hosting](docs/hosting.md) replaces the Self-hosting guide.
- Every image records the commit it was built from, shown by `/api/health` and **Admin → Service health**. A build that can't name its commit stops, so uncommitted work can't reach production unnoticed.
- The image's base is pinned by digest and no longer upgraded during the build, so the same commit builds the same image. It no longer carries npm, Yarn or browser-only packages.
- The data volume is no longer marked resettable, so a walctl reset can't empty it.
- Server libraries updated to versions without known security advisories.

- `RELAY_ORIGIN` is optional. Unset, Relay answers at whatever address it's opened at. Set it to accept only one address.
- `RELAY_SECRET` is no longer required. Relay generates one and keeps it with the data.

### Removed

- `RELAY_ADMIN_PASSWORD` and the built-in `admin` account. The administrator is created during setup.
- `RELAY_CADDY_TRUSTED_PROXIES`, `RELAY_SOCKET` and the fixed backend network settings (`RELAY_BACKEND_SUBNET`, `RELAY_GATEWAY_IP`, `RELAY_APP_IP`). Use `RELAY_TRUST_PROXY`.

- Backup snapshots, the backup volume, the `RELAY_BACKUP_*` settings and the `npm run ops` command. Everything Relay stores lives in the data volume.
- The maximum file size limit. A file only has to fit the member's storage and the service capacity.
- The Compose files, `.env.example`, `scripts/redeploy.sh` and `npm run verify:compose`. They described a way of running Relay that production doesn't use and nobody tested.
- Old bundled copies of the Walriyami sign-in package in `vendor/` that nothing installed; only the version in use remains.

### Fixed

- The Usage page and the Admin pages no longer add up every stored file each time they refresh, which held up every transfer meanwhile. With half a million files on a laptop, the Admin usage view went from about 350 ms to 50 ms, a member's Usage page from about 240 ms to 20 ms, and the Admin overview from about 110 ms to 40 ms.
- Moving an item to Trash pauses its links and codes instead of turning them off for good. Restoring it, or **Undo**, makes them work again, including links an earlier version turned off this way.
- Deleting forever, emptying Trash and the automatic purge no longer freeze Relay for everyone while files are removed (about 15 ms per file before). Items go at once and their files are deleted in the background in small batches; left-over clean-up from before is worked through right away instead of 100 files a minute, and at startup without holding it up.
- Opening a share page no longer counts as a download or tells the owner “Someone downloaded”. Only saving a whole file or a ZIP counts.
- Any item downloads as a ZIP, however many files it has collected. Archives used to stop at 20,000 entries, fewer than one upload may hold, and now use a fraction of the memory.
- File times in a ZIP are no longer shifted by the time zone. They show as the time the file was added, in the downloader's own zone.
- Members now see when one of their files is damaged or missing on disk: Files says how many, the item shows a red warning, and the item window marks each damaged file and explains that uploading the same file again repairs it. Admin lists which members are affected and how many files, without naming the files.

## [1.0.0] - 2026-09-27

The first public release.

### Added

- Send files, folders and text, then choose where they go: your library, a share link, or another of your devices.
- Resumable uploads of any size that survive network drops and server restarts, and streamed downloads with byte ranges and ZIP archives.
- Share links with a QR code and a short pickup code. Links can expire, need a password, admit only one person and carry a note, and they show how many people opened and downloaded them.
- Upload requests that let anyone send files to you without an account.
- A library with search, previews of images, video, audio, PDFs and text, folder downloads as ZIP, and a 30-day trash.
- Invite-only accounts with passwords, passkeys and sign-in codes from another device, plus an administrator panel for accounts and limits.
- Automatic, verifiable backup snapshots and a restore command.
- A Docker image and a Compose file for self-hosting.

[1.0.0]: https://github.com/walriyami/Relay/releases/tag/v1.0.0
