# Relay on its own server (Docker + Cloudflare Tunnel)

This folder runs Relay on a Linux machine that has nothing else on it: no Walriyami Control, no gateway. Three
small programs run in Docker:

- **relay**: the app.
- **cloudflared**: connects out to Cloudflare, so people reach Relay at your web address. Nothing on the machine
  is opened to the internet or to your home network; no router changes are needed.
- **egress**: the only way Relay can reach the internet, and only to the phone and browser notification
  services. If someone ever broke into Relay, they couldn't use it to reach anything else.

Everything Relay keeps (accounts, files, links) lives in one Docker storage area called `relay-data`, which
survives updates and restarts.

What's different from the Raspberry Pi copy: no Walriyami sign-in (everyone uses a Relay password or passkey), no
automatic backups (run `./backup.sh`, below), and no Direct transfers (they need the server on the same home
network as the people using it; this server is reached only through Cloudflare). More detail is in
[docs/hosting.md](../docs/hosting.md#plain-docker-and-a-cloudflare-tunnel).

All commands below are typed on the server, in a terminal.

## What you need

- A 64-bit Linux machine (Debian or Ubuntu are easiest), on the internet. 2 GB of memory is plenty, plus disk space
  for the files people will send.
- A domain whose DNS is on Cloudflare (here `buildhatch.dev`). Relay takes the whole name: the steps below point
  `buildhatch.dev` itself at this machine, replacing whatever it pointed to before.

## First start

**1. Install Docker and git.** On Debian or Ubuntu:

```sh
sudo apt update && sudo apt install -y git curl
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and back in, so the last line takes effect. (It lets your account run Docker without `sudo`. That makes
your account as powerful as `root` on this machine, which is fine on a server that only you use.)

**2. Get Relay.**

```sh
git clone https://github.com/walriyami/Relay.git ~/relay
cd ~/relay/deploy
```

If GitHub asks for a password, the repository is private: sign in with a GitHub access token as the password.

**3. Fill in the settings.**

```sh
cp example.env .env
nano .env
```

`RELAY_ORIGIN` is already `https://buildhatch.dev`. For another address, change it to `https://` followed by
the exact name, with nothing after it. Pick it for good: changing it later breaks every link and passkey already
handed out. Save with Ctrl+O and Enter, close with Ctrl+X.

**4. Create the tunnel.**

```sh
./tunnel-setup.sh
```

1. It prints a Cloudflare link. Open it in a browser (on this machine or any other), sign in to Cloudflare, and
   choose `buildhatch.dev`. The script carries on by itself once you have.
2. It creates a tunnel named `relay-buildhatch.dev` and keeps its key in `secrets/tunnel_credentials.json`.
3. It points `buildhatch.dev` at the tunnel, replacing any other DNS record for that name.
4. It writes the tunnel's ID into `.env`.

The key in `secrets/` lets whoever holds it serve your address: don't share it or copy it anywhere else. The
sign-in from step 1 isn't kept, because it could change any tunnel or DNS record of the domain; running the
script again just asks you to sign in again.

If it stops with an error about an existing DNS record, delete the records named `buildhatch.dev` in the
Cloudflare dashboard (**DNS → Records**) and run it again.

**5. Start it.**

```sh
./up.sh
```

The first build takes several minutes (longer on an old machine). It ends with "Relay is up." and a list where
all three show `healthy`. If something stays unhealthy, the script says how to see why.

**6. Create the administrator.** Read the one-time setup key:

```sh
docker compose logs relay | grep "Setup key"
```

Open https://buildhatch.dev in a browser, paste the key, and choose the administrator's username and password. Do it
straight away: until the administrator exists, anyone who learns the key could claim the server. The key stops
working once setup is done. Then invite people from **Admin → Members**.

## Updating

Take a backup first, then fetch the new version and rebuild:

```sh
cd ~/relay/deploy
./backup.sh
git pull
./up.sh
```

Relay is unavailable for a few seconds while it swaps; transfers in progress pause and carry on by themselves.
Your data stays. `up.sh` refuses to build if Relay's files were edited on the server, so what runs is always
exactly a saved version.

## Where the data lives

In the Docker storage area (volume) `relay-data`. On a standard Linux install that is the folder
`/var/lib/docker/volumes/relay-data/_data`, readable only by `root`. It holds the database, every stored file,
unfinished uploads, and Relay's secret key (which signs every link).

It is kept when Relay is updated, restarted, or stopped with `docker compose down`. It is deleted only by
`docker compose down -v` or `docker volume rm relay-data`: never type those unless you mean to erase everything.

## Backups

```sh
cd ~/relay/deploy
./backup.sh
```

This stops Relay for a moment, saves everything to `backups/relay-<date>-<time>.tar.gz`, and starts it again.

- **Copy backups off the machine.** A backup on the same disk doesn't help if the disk dies. From your own
  computer, for example: `scp you@server:relay/deploy/backups/relay-*.tar.gz .`
- **Keep them private.** A backup holds every file and the key that signs every link: anyone who has it can read
  everything, as if they had the server.
- Deleted files live on in older backups until you delete those.

To put a backup back (this replaces everything Relay holds now, and asks you to type `restore` first):

```sh
./restore.sh backups/relay-2026-11-25-0300.tar.gz
```

To back up every night at 3 a.m., run `crontab -e` and add this line (with your own username):

```
0 3 * * * /home/you/relay/deploy/backup.sh >/dev/null 2>&1
```

## Everyday checks

- Is it running? `docker compose ps` (all three should say `healthy`).
- What's it saying? `docker compose logs --tail 100 relay` (or `cloudflared`, or `egress`).
- Docker restarts Relay if it crashes, and after the machine reboots. It does **not** restart a copy that is
  running but unhealthy; if `ps` shows `unhealthy` for more than a few minutes, run `docker compose restart relay`.
- Keep the machine itself updated (`sudo apt update && sudo apt upgrade`, or turn on `unattended-upgrades`).

## Locked out of the administrator account

If every administrator has lost their password and passkeys:

1. In `.env`, set `RELAY_RECOVER_ADMIN=` to the administrator's username, then run `./up.sh`.
2. `docker compose logs relay | grep "recovery link"` shows a one-time link, valid for 24 hours.
3. Open it and choose a new password.
4. Empty `RELAY_RECOVER_ADMIN=` again and run `./up.sh`.

The link is as powerful as the password: don't paste the log anywhere.

## The files in this folder

| File                | What it is                                                                    |
| ------------------- | ----------------------------------------------------------------------------- |
| `compose.yaml`      | The three programs and their limits. No need to edit it.                      |
| `example.env`       | The settings to copy to `.env`: the address, the tunnel, the recovery switch. |
| `egress/squid.conf` | The list of places Relay may reach: the notification services only.           |
| `tunnel-setup.sh`   | Creates the Cloudflare Tunnel and points your address at it. Run once.        |
| `up.sh`             | Builds the version you have and starts or restarts everything.                |
| `backup.sh`         | Saves all of Relay's data to `backups/`.                                      |
| `restore.sh`        | Puts a backup back.                                                           |
| `.env`, `secrets/`  | Yours, created above. Never committed to git.                                 |
