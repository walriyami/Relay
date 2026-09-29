# Changelog

All notable changes to Relay are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First-start setup in the browser: create the administrator account, choose what everyone gets, and invite your first person. Relay needs no settings to start.
- Per-member settings. Each member has their own storage, upload retention, link lifetime and Trash retention. Setup chooses what new members start with, and **Admin → New members** changes it later.
- Administrators can change a member's name, username, link lifetime and Trash retention.
- Members choose how long Trash keeps what they delete, in **Settings → Storage**.
- Direct transfers. On the server's own network, members' uploads and downloads go straight to Relay over WebRTC instead of the internet connection, with nothing to set up on their devices. A **Direct** button in the top bar shows when this is on and switches it off. It's on by default and needs no configuration: Relay runs the helper itself, and the connection comes up without any address being set, including on Docker Desktop and when the server changes networks. On Linux, `compose.host.yaml` gives Relay the host's network for them. See [Self-hosting](docs/self-hosting.md#direct-transfers-on-your-network).
- Nearby, a tab of its own for sending files and text straight from one device to another on the same network, without going through Relay or into Files. Your own signed-in devices always appear and take what you send without asking. Other members appear on the same network, must accept, and can hide themselves with **Visible to people nearby**. Someone without an account joins with a Nearby code or link. Received photos save to the photo library through the share sheet on phones and tablets, and computers download files or one ZIP. Transfers pick up where they left off if the connection drops. When your own device can't be reached directly, **Send via Relay** sends the same files the usual way. See [Self-hosting](docs/self-hosting.md#nearby).

- `RELAY_TRUST_PROXY` accepts host names, such as a tunnel connector's container name, which Relay follows as Docker readdresses it.
- The web app's text files are Brotli- and gzip-compressed at build time and served precompressed.

### Changed

- Relay runs as one container. The Caddy gateway, its Unix socket and `RELAY_SOCKET` are gone: Relay serves HTTP itself on `127.0.0.1:3090`, and a tunnel connector reaches it at `http://relay:3090` through `compose.tunnel.yaml`. Every visitor through a tunnel now gets their own rate limits, instead of all sharing the connector's.
- Compose overlays are chosen once in `.env` with `COMPOSE_FILE`, so later commands can't leave one out.

- `RELAY_ORIGIN` is optional. Unset, Relay answers at whatever address it's opened at. Set it to accept only one address.
- `RELAY_SECRET` is no longer required by `compose.yaml`. Relay generates one and keeps it with the data.

### Removed

- `RELAY_ADMIN_PASSWORD` and the built-in `admin` account. The administrator is created during setup.
- `RELAY_CADDY_TRUSTED_PROXIES`, `RELAY_SOCKET` and the fixed backend network settings (`RELAY_BACKEND_SUBNET`, `RELAY_GATEWAY_IP`, `RELAY_APP_IP`). Use `RELAY_TRUST_PROXY`.

- Backup snapshots, the backup volume, the `RELAY_BACKUP_*` settings and the `npm run ops` command. Everything Relay stores lives in the data volume.
- The maximum file size limit. A file only has to fit the member's storage and the service capacity.

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
