// Which saved version of the code this server runs, shown on Admin and in /api/health.
//
// Production is built with `walctl deploy relay-production --commit <ref>`, which hands Docker a
// `git archive` of that commit. Git fills in the two placeholders below while archiving (see
// .gitattributes, `export-subst`). The image build then copies them into build.json with
// `node server/build-stamp.ts`, which refuses to build an image that names no commit. A build from
// a working tree (`walctl deploy` without --commit, or `docker build .`) keeps the placeholders and
// must pass the commit as the RELAY_COMMIT build argument instead.
import { readFileSync } from "node:fs";

const ARCHIVED = { commit: "$Format:%H$", date: "$Format:%cI$" };
const STAMP = new URL("build.json", import.meta.url);
const PACKAGE = new URL("../package.json", import.meta.url);

export interface BuildInfo {
  version: string;
  /** The full commit hash, or null when this copy was not built from a commit (development). */
  commit: string | null;
  /** When that commit was made (ISO 8601), when known. */
  committed: string | null;
}

const isCommit = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

/** The commit git archive wrote into this file, if this copy came from one. */
export function archivedCommit(): { commit: string; committed: string | null } | null {
  if (!isCommit(ARCHIVED.commit)) return null;
  return { commit: ARCHIVED.commit, committed: ARCHIVED.date.startsWith("$") ? null : ARCHIVED.date };
}

function read(): BuildInfo {
  const version = (JSON.parse(readFileSync(PACKAGE, "utf8")) as { version: string }).version;
  const archived = archivedCommit();
  if (archived) return { version, ...archived };
  try {
    const stamp = JSON.parse(readFileSync(STAMP, "utf8")) as { commit?: unknown; committed?: unknown };
    if (isCommit(stamp.commit))
      return { version, commit: stamp.commit, committed: typeof stamp.committed === "string" ? stamp.committed : null };
  } catch {
    // No stamp: a development checkout.
  }
  return { version, commit: null, committed: null };
}

export const build: BuildInfo = read();
