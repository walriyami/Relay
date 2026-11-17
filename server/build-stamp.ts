// Runs once while the Docker image is built: records which commit the image holds in
// server/build.json, or stops the build when it can't tell. That keeps half-finished work in a
// working tree from reaching production unnoticed. See server/build-info.ts.
//
//   node server/build-stamp.ts [<commit>]
//
// The commit comes from git archive's placeholders when walctl built from `--commit`, otherwise
// from the argument (the Dockerfile passes its RELAY_COMMIT build argument).
import { writeFileSync } from "node:fs";
import { archivedCommit } from "./build-info.ts";

const given = (process.argv[2] ?? "").trim().toLowerCase();
const stamp = archivedCommit() ?? (/^[0-9a-f]{40}$/.test(given) ? { commit: given, committed: null } : null);

if (!stamp) {
  console.error(
    [
      "This image would not say which commit it holds, so the build stops here.",
      "Deploy a saved commit:  walctl deploy relay-production --commit main",
      "Or, for a local or CI image, name it:  docker build --build-arg RELAY_COMMIT=$(git rev-parse HEAD) .",
    ].join("\n"),
  );
  process.exit(1);
}
writeFileSync(new URL("build.json", import.meta.url), JSON.stringify(stamp) + "\n");
process.stdout.write(`Building Relay from commit ${stamp.commit}.\n`);
