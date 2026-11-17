# Historical documentation

These files are preserved evidence from earlier AI-assisted work. They are not an active roadmap, product
requirements, review criteria, current task instructions, or verification of today's app. Form an independent
assessment before consulting them. Check any relevant claim against the current source and running candidate.

| Record                                             | Original scope                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Efficiency audit](2026-09-28/efficiency-audit.md) | Measurements and proposed improvements from 28 September 2026                  |
| [Security audit](2026-09-30/security-audit.md)     | Report about the source and deployment candidate recorded on 30 September 2026 |
| [Security evidence](2026-09-30/security-audit/)    | Candidate-specific reports, inventories, coverage, and deployment metadata     |

The payload files were moved unchanged on 2 October 2026. [The manifest](manifest.json) records their original paths,
archive paths, and SHA-256 hashes. Relative links between the security report and its evidence remain intact.
Paths embedded in historical reports and machine-readable evidence describe their original locations; they are
not current executable instructions. Resolve an old `docs/` path through the manifest.

Existing local working bundles were moved together from `work/` to `work/archive/2026-10-02/`, preserving their
contents and internal layout. Their local manifest is `work/archive/manifest.json`. This includes old state files,
plans, review reports, logs, probes, screenshots, and candidate copies. An original `work/<path>` now resolves to
`work/archive/2026-10-02/<path>`. Local working evidence is ignored by Git and is not included in a fresh clone.

Old pending-work statements, worker identifiers, approvals, and deployment instructions must not be resumed from
these archives. Their presence records history, not authorization. See [the current review guide](../review.md).
