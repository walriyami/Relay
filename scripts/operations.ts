// Operator commands for Relay backups. Run with the bundled Node 24: `npm run ops -- <command> ...`.
import { resolve } from "node:path";
import { listSnapshots, readManifest, restoreSnapshot, verifySnapshot } from "../server/modules/backup/format.ts";

const HELP = `Usage:
  operations list <backupDir>
      Lists snapshots oldest first, including directories with unreadable manifests.
  operations verify <backupDir> [snapshot]
      Checks the database checksum and integrity and every stored file's size and SHA-256.
      Without a snapshot name, verifies all of them.
  operations restore <backupDir> <snapshot|latest> <emptyDataDir>
      Verifies the snapshot, then writes it as a new data directory. Point RELAY_DATA at it.

A restored instance has no sessions: everyone signs in again. Share links and upload request links
keep working only when the restored instance uses the same RELAY_SECRET (or a copy of the original
data directory's secret.key); otherwise the content is intact but old links stop working.`;

function pick(backupDir: string, name: string | undefined): string {
  const names = listSnapshots(backupDir);
  const chosen = name === "latest" ? names.at(-1) : names.find((n) => n === name);
  if (!chosen)
    throw new Error(name === "latest" ? "There are no snapshots in that directory." : `No snapshot named ${name}.`);
  return chosen;
}

async function main(args: string[]) {
  const [command, dir, ...rest] = args;
  if (!command || !dir || command === "help") return console.log(HELP);
  const backupDir = resolve(dir);
  switch (command) {
    case "list":
      for (const name of listSnapshots(backupDir)) {
        try {
          const manifest = readManifest(backupDir, name);
          const bytes = manifest.blobs.reduce((sum, b) => sum + b.size, 0);
          console.log(
            `${name}  ${new Date(manifest.created).toISOString()}  ${manifest.blobs.length} files  ${bytes} bytes`,
          );
        } catch {
          console.log(`${name}  unreadable manifest; preserved and blob collection skipped`);
        }
      }
      return;
    case "verify":
      for (const name of rest[0] ? [pick(backupDir, rest[0])] : listSnapshots(backupDir)) {
        try {
          const manifest = await verifySnapshot(backupDir, name);
          console.log(`${name}: verified (${manifest.blobs.length} files).`);
        } catch (error) {
          console.error(`${name}: verification failed: ${error instanceof Error ? error.message : String(error)}`);
          process.exitCode = 1;
        }
      }
      return;
    case "restore": {
      const [name, destination] = rest;
      if (!destination) throw new Error("restore needs <backupDir> <snapshot|latest> <emptyDataDir>.");
      const chosen = pick(backupDir, name);
      const manifest = await restoreSnapshot(backupDir, chosen, resolve(destination));
      console.log(`Restored ${chosen} (${manifest.blobs.length} files) into ${resolve(destination)}.`);
      console.log("Start Relay with RELAY_DATA pointing there, and the original RELAY_SECRET to keep links working.");
      return;
    }
    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
