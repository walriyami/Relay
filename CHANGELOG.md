# Changelog

All notable changes to Relay are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First-start setup in the browser: create the administrator account, choose what everyone gets, and invite your first person. Relay needs no settings to start.
- Per-member settings. Each member has their own storage, upload retention, link lifetime and Trash retention. Setup chooses what new members start with, and **Admin → New members** changes it later.
- Administrators can change a member's name, username, link lifetime and Trash retention.
- Members choose how long Trash keeps what they delete, in **Settings → Storage**.

### Changed

- `RELAY_ORIGIN` is optional. Unset, Relay answers at whatever address it's opened at. Set it to accept only one address.
- `RELAY_SECRET` is no longer required by `compose.yaml`. Relay generates one and keeps it with the data.

### Removed

- `RELAY_ADMIN_PASSWORD` and the built-in `admin` account. The administrator is created during setup.

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
