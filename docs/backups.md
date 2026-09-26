# Backups and restore

Relay takes recovery snapshots automatically. Backups are managed by whoever runs the server, so members and administrators never see backup controls in the app.

## How snapshots work

- A snapshot is taken every `RELAY_BACKUP_INTERVAL_HOURS` (default 24), starting one interval after Relay first starts. The newest `RELAY_BACKUP_KEEP` (default 7) are kept.
- Each snapshot is a consistent copy of the SQLite database, taken while Relay keeps running. Sign-in sessions and unfinished uploads are left out.
- File contents go into a shared pool beside the snapshots. Only new files are copied, and each is checked against its SHA-256 while it's copied. Pool entries that no remaining snapshot needs are removed.
- Snapshots are written to `RELAY_BACKUP_DIR`, which is the `relay-backups` volume in Docker.

> [!IMPORTANT]
> A backup on the same disk protects you from mistakes, not from losing the disk. Mount the backup volume on a different disk, or regularly copy the **whole** backup directory somewhere else, for example with `rsync` or `restic`. Snapshots need their pool, so copy them together.
>
> Keep your `RELAY_SECRET` with the backups too. Without it, restored content is intact but old share links stop working.

## Inspect and verify

With Docker Compose:

```sh
docker compose exec relay node scripts/operations.ts list /backups
docker compose exec relay node scripts/operations.ts verify /backups             # every snapshot
docker compose exec relay node scripts/operations.ts verify /backups <snapshot>  # one snapshot
```

From a source checkout, run `npm run ops -- list /path/to/backups` and the other commands the same way.

`verify` checks the database checksum and runs SQLite's `integrity_check`. It also checks the size and SHA-256 of every file the snapshot refers to.

## Restore

Always restore into a **new, empty** volume, check the result, and only then switch over. Keep the old volume until the restored instance has proven itself.

```sh
# 1. Write the latest snapshot into a fresh volume.
docker volume create relay-restored
docker run --rm \
  -v relay_relay-backups:/backups:ro \
  -v relay-restored:/data \
  relay:1.0.0 node scripts/operations.ts restore /backups latest /data

# 2. Check it with a temporary instance on another port, using the same RELAY_SECRET.
docker run --rm -p 127.0.0.1:3091:3090 \
  -v relay-restored:/data \
  -e RELAY_ORIGIN=http://localhost:3091 \
  -e RELAY_SECRET="$RELAY_SECRET" \
  relay:1.0.0
```

To restore a specific snapshot, replace `latest` with a name from `list`.

Open http://localhost:3091, sign in and download a few files. Everyone has to sign in again after a restore, because sessions aren't backed up. When you're satisfied, stop the temporary instance and point your main service at the restored volume. For example, in a `compose.override.yaml`:

```yaml
volumes:
  relay-data:
    name: relay-restored
    external: true
```

The Compose project is named `relay`, so its volumes are `relay_relay-data` and `relay_relay-backups`.
