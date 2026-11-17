# Changelog

All notable changes to Relay are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- First-start setup in the browser: create the administrator account, choose what everyone gets, and invite your first person. Relay needs no settings to start.
- Per-member settings. Each member has their own storage, upload retention, link lifetime and Trash retention. Setup chooses what new members start with, and **Admin → New members** changes it later.
- Administrators can change a member's name, username, link lifetime and Trash retention.
- Members choose how long Trash keeps what they delete, in **Settings → Storage**.
- Direct transfers. On the server's own network, members' uploads and downloads go straight to Relay over WebRTC instead of the internet connection, with nothing to set up on their devices. A **Direct** button in the top bar shows when this is on and switches it off. It's on by default: Relay runs the helper itself. Browsers need to reach its UDP port on the home network: on the host's network or Docker Desktop that needs no setup, and behind a Docker bridge (as on relay.walriyami.com) the port is published on the host's home address and `RELAY_DIRECT_ADDRESSES` names it. See [Hosting](docs/hosting.md#direct-transfers-on-your-network).
- Nearby, a tab of its own for sending files and text straight from one device to another on the same network, without going through Relay or into Files. Your own signed-in devices always appear and take what you send without asking. Other members appear on the same network, must accept, and can hide themselves with **Visible to people nearby**. Someone without an account joins with a Nearby code or link. Received photos save to the photo library through the share sheet on phones and tablets, and computers download files or one ZIP. Transfers pick up where they left off if the connection drops. When your own device can't be reached directly, **Send via Relay** sends the same files the usual way. See [Hosting](docs/hosting.md#nearby).
- Direct transfers and Nearby spread their bytes over several WebRTC connections at once, since a browser lets each connection carry only a few megabits a second over Wi-Fi. The first connection carries only control messages once the others are open, so a transfer doesn't stall for seconds at the start.
- Sending to one of your devices no longer needs Relay open on it. The delivery waits, and the device gets it the next time it opens Relay. The sender sees **Waiting for…**, then **Delivered to…**, **Downloaded on…** or **Declined on…**, each saying a copy is kept in Files. Devices not seen for two weeks fold away under **Show … not seen lately**.

- Relay installs as an app on phones and computers, opening in its own window, and appears in the share sheet: files, text and links shared to it land in the Send draft. On iPhone, a Shortcut can send text and links. See [On your phone](README.md#on-your-phone).
- Notifications on each device, even with Relay closed, when something arrives for that device, someone sends files to your request, or a link is first downloaded. They're off until turned on in **Settings → Arrivals**; on iPhone and iPad they need Relay added to the Home Screen.
- A **Share…** button for links on phones, and received photos and videos save to Photos through the share sheet.
- Administrators can make another member an administrator and take the role away again. Relay always keeps at least one.
- **Remove member**, in a member's **Manage** dialog, deletes their account, files and links. The confirmation says what goes and how much space that frees, and asks for their username.
- `RELAY_RECOVER_ADMIN` recovers an administrator who lost their password: Relay writes a one-time link to its log. See [Hosting](docs/hosting.md#recovering-administrator-access).
- **Settings → Storage** shows what takes the most space, what Trash still holds with a button to empty it, and **Download all my files**, one ZIP of everything in Files.
- **Admin → Overview → History**: who joined, left, was suspended or became an administrator, what members sent and shared, failed sign-ins and errors, for the last 90 days. It can be narrowed to one kind of event or one member. It never records file names, link addresses or contents.

- `RELAY_TRUST_PROXY` accepts host names, such as a tunnel connector's container name, which Relay follows as Docker readdresses it.
- The web app's text files are Brotli- and gzip-compressed at build time and served precompressed.

### Changed

- The Activity bell counts only news: sign-ins on a kind of device you already use and links that were only opened no longer light it up. A sign-in on a new kind of device says so and links to your devices.
- Editing `server/db/schema.sql` no longer locks Relay out of existing data. At startup Relay adds new tables, columns and indexes itself, ignores comments and formatting, and refuses only an edit that would remove or reshape stored data, with a message naming it. The one-off upgrade from the first schema is gone.
- A damaged database stops Relay at startup with a plain explanation and recovery steps instead of a stack trace. Startup errors Relay understands are printed the same way.
- The health check reports what is wrong instead of always answering "ok": it names problems (`database`, `disk-space`, `stored-files`, `usage-records`, `maintenance`), notices a disk that stops taking writes, and fails with a 503 only when the database can't be read or is damaged. **Admin → Overview** says when the database couldn't save a change.
- `control-reset --content` keeps invitations' codes and every code ever given out, so a printed code is never reused. `--clone` also removes notification subscriptions and the push key, so a copy never notifies the original's phones. The tables each reset clears are listed explicitly; a new table is kept until someone decides otherwise.
- Send has a clear main action and no greyed-out panel: an empty draft offers **Choose files**, and the place to send stays put as things are added. After a link is made, the link itself is shown. Each upload uses your own retention setting, so the per-draft retention menu is gone.
- Send and Nearby each say in one line what they do: Send goes through Relay and keeps a copy in Files; Nearby goes straight between devices on the same network and keeps nothing.
- Nearby says **Delivered to…** only once the other device has everything, and says no copy was kept. Arrivals from your own device download on their own on a computer, and the page asks before it's closed with an arrival not yet saved.

- Relay runs as one container. The Caddy gateway, its Unix socket and `RELAY_SOCKET` are gone: Relay serves HTTP itself on port 3090.
- Relay is hosted with walctl, which builds, runs, health-checks and rolls back the container. [Hosting](docs/hosting.md) replaces the Self-hosting guide.
- Every image records the commit it was built from, shown by `/api/health` and **Admin → Overview → Server details**. A build that can't name its commit stops, so uncommitted work can't reach production unnoticed.
- The image's base is pinned by digest and no longer upgraded during the build, so the same commit builds the same image. It no longer carries npm, Yarn or browser-only packages.
- The data volume is no longer marked resettable, so a walctl reset can't empty it.
- Server libraries updated to versions without known security advisories.
- While Relay opens, it shows the app's frame and placeholder rows instead of a blank "Opening Relay" screen.
- Links and Requests show each one's state as small coloured chips (expires soon, opened, full, closed) with a picture of what's shared, instead of lines of grey text. A link's password lock sits in front of its name.
- Card titles no longer show a sliver of a third line under long names.
- Sign-in, code entry, shared links and request pages use one layout, with the brand above the card. Every code field is called **Code**.
- When an item moves to Trash is changed from **Change** beside its date in the item's details, not from the card menu, and the dates are written plainly ("Relay removes it on 3 March").
- Settings has fewer sections: **Sharing**, **Storage**, **This device**, **Activity**, **Devices**, **Account** and **Passkeys**. Every choice saves as it's made and shows a quiet "Saved" beside its section. Devices not used for 30 days are folded away.
- What happens when your devices send something here is one choice, **Download it** or **Ask me**. A download no longer also opens a window asking to download it again; text still opens so you can read it.
- A new member's welcome asks only for their name. How long links and files last starts with the defaults and is in Settings.
- On phones and tablets, option pickers and icon-only buttons are full 44-pixel touch targets, buttons give a little when pressed, and the page clears the notch when the phone is held sideways.
- With reduced motion on, spinners and placeholders pulse gently instead of freezing.
- The **Direct** button in the top bar looks like its neighbours, and on phones it says "Direct" under its bolt instead of showing a bare icon.

- **Admin → Overview** says first, in plain words, whether anything is wrong, how much space is left and what is waiting for the administrator. Trends over time and each member's share follow, then History. How the server runs moves under **Server details**, and request counts became a sentence about whether things worked.
- Opening a file to look at it in the app no longer counts as a download. **Download all my files** does.

- `RELAY_ORIGIN` is optional. Unset, Relay answers at whatever address it's opened at. Set it to accept only one address.
- `RELAY_SECRET` is no longer required. Relay generates one and keeps it with the data.

### Removed

- `RELAY_ADMIN_PASSWORD` and the built-in `admin` account. The administrator is created during setup.
- `RELAY_CADDY_TRUSTED_PROXIES`, `RELAY_SOCKET` and the fixed backend network settings (`RELAY_BACKEND_SUBNET`, `RELAY_GATEWAY_IP`, `RELAY_APP_IP`). Use `RELAY_TRUST_PROXY`.

- Backup snapshots, the backup volume, the `RELAY_BACKUP_*` settings and the `npm run ops` command. Everything Relay stores lives in the data volume.
- The maximum file size limit. A file only has to fit the member's storage and the service capacity.
- The Compose files, `.env.example`, `scripts/redeploy.sh` and `npm run verify:compose`. They described a way of running Relay that production doesn't use and nobody tested.
- Old bundled copies of the Walriyami sign-in package in `vendor/` that nothing installed; only the version in use remains.
- The **One browser only** option for new links. A password, an expiry or **Turn off** covers the same need. Links that already have it keep it, and can lift it in **Link settings**.
- The separate **Open items as soon as they arrive** setting, now part of the one arrivals choice.

### Fixed

- The Usage page and the Admin pages no longer add up every stored file each time they refresh, which held up every transfer meanwhile. With half a million files on a laptop, the Admin usage view went from about 350 ms to 50 ms, a member's Usage page from about 240 ms to 20 ms, and the Admin overview from about 110 ms to 40 ms.
- Moving an item to Trash pauses its links and codes instead of turning them off for good. Restoring it, or **Undo**, makes them work again, including links an earlier version turned off this way.
- Deleting forever, emptying Trash and the automatic purge no longer freeze Relay for everyone while files are removed (about 15 ms per file before). Items go at once and their files are deleted in the background in small batches; left-over clean-up from before is worked through right away instead of 100 files a minute, and at startup without holding it up.
- Opening a share page no longer counts as a download or tells the owner “Someone downloaded”. Only saving a whole file or a ZIP counts.
- Any item downloads as a ZIP, however many files it has collected. Archives used to stop at 20,000 entries, fewer than one upload may hold, and now use a fraction of the memory.
- File times in a ZIP are no longer shifted by the time zone. They show as the time the file was added, in the downloader's own zone.
- Members now see when one of their files is damaged or missing on disk: Files says how many, the item shows a red warning, and the item window marks each damaged file and explains that uploading the same file again repairs it. Admin lists which members are affected and how many files, without naming the files.

### Security

- Responses no longer tell visitors how much of their request budget is left; a refusal still says when to try again.
- Link passwords need at least 8 characters, and wrong guesses are counted per network, so someone guessing a link's password can no longer lock out the person it was meant for. A link still takes at most 100 wrong passwords an hour in all.
- A fresh or reset server can no longer be claimed by whoever opens it first. Setup asks for a one-time key that Relay prints in its server log (and keeps in `<data>/setup.key` until setup is done). With Walriyami sign-in configured, Walriyami's administrator can instead claim it by signing in. `RELAY_SETUP_KEY` is now on by default; set it to `false` only on a machine nobody else can reach.
- One person typing wrong codes can no longer pause code entry for everyone. Each network gets a few wrong tries; when many networks guess at once, each wider network gets only a few a day, Admin shows when it happened, and right codes keep working for everyone else.
- Pickup and sign-in codes are always six digits and work for a day; the owner's screen shows a fresh code when the old one ends, and links and QR codes don't change. An ended code's digits can be used again after 30 days, so Relay never runs out of codes. The four-digit setting is gone.
- One account can make at most 100 sign-in codes a day.
- Strangers guessing a member's password can no longer lock them out: a browser the member has signed in on before keeps working, each network gets only a few wrong tries, and a flood of guesses can't crowd out everyone's sign-ins. Joins with a dead invitation are turned away before any password work.
- New passwords need at least 10 characters. Existing shorter passwords keep working.
- Walriyami Control being unreachable no longer signs out everyone who signed in with Walriyami. Sessions it confirmed within the last hour keep working, and after that requests wait for Control instead of ending. Only Control's own answer ends a session.
- People who join by signing in with Walriyami now show in Admin with a **Walriyami** label, and administrators are told when they join. Their usernames follow the same rules as everyone else's.
- Image previews only ever decode PNG, JPEG, GIF, WebP and HEIF/AVIF, judged by the file's bytes. A file named like a photo but holding another format, such as SVG or TIFF, never reaches a decoder.
- An upload that stops receiving bytes gives its reserved room back: after 30 minutes for someone using a request link, after a day for a member. One visitor can no longer fill a request for everyone by declaring a large upload and sending nothing.
- `RELAY_CLIENT_IP_HEADER` reads the visitor's address from a header such as Cloudflare's `CF-Connecting-IP`, sent by a trusted proxy. Behind a tunnel with a gateway in front of Relay, every visitor shared one set of limits; now each gets their own.

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
