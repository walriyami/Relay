# Independent Nearby correctness review

Result: **58/58 tests passed** against the coordinator's frozen Nearby source: 15 independent audit checks, 32 producer audit checks and 11 existing Nearby/Lanes/ZIP controls. After lint-only fixture corrections, the independent suite passed again, 15/15. TypeScript, owned-file ESLint and Prettier checks passed. No verified correctness counterexample remains in this reviewed slice.

Scope: `/Users/riyami/.codex/worktrees/security-audit/Relay`, production `client/lib/nearby/engine.ts`, `protocol.ts`, `link.ts`, and `tests/security-audit-nearby.test.ts`. This verifier did not implement or edit the production changes or the producer's test file. All independent fixtures are separate disposable browser storage and WebRTC adapters, with production Link, Lanes, Mux, engine, and disk/memory sink code executing unchanged. No deployed data or external targets were used.

## Concrete counterexample found and corrected

Before the final freeze, the independent delayed-space test held `navigator.storage.estimate()`, removed the peer, then returned insufficient space. `accept()` handled that result before checking its current state, so it overwrote the cancelled record with `failed` and issued a stale decline/failure notice. The initial independent run observed `failed` where `cancelled` was required.

The coordinator corrected the checkpoint: the current incoming state is checked immediately after `roomFor()` resolves, before either admission branch. The frozen-source regression now observes `cancelled`. Evidence: `nearby-independent-initial.log`, `nearby-independent-initial.json`, `nearby-independent-final-owned.log`.

## Observed controls

- Peer removal cancels pending incoming offers, accepted receives, established outgoing streams and outgoing transfers whose connection has not opened. Links close and cancelled transfers do not reconnect. Late credits/completion controls on the old or a newly established link cannot turn the old outgoing record into a completed transfer.
- Independently held production disk-sink opening, writing and assembly all remain cancelled after peer removal. No `received` notice is emitted, no received file appears, and the disposable disk entries are removed. The producer suite separately checks pending file reads, queued storage work, late text assembly and controlled sink boundaries.
- Re-listing the same peer permits a fresh transfer while the previous transfer remains cancelled. An initial unknown introduction waits for its directory entry, accepts normally and finishes with its exact text payload.
- Malformed control discriminants, field types and numeric bounds close the established link without escaping the callback. Resume checks reject offsets beyond the actual File/Blob payload and nonexistent entry keys before binary sending. Valid zero and exact-size offsets work, and every observed frame ends within the corresponding file/text payload size.
- Known offers resume even when new admission is full. New unsolicited receives are bounded to eight per peer and 32 active globally. Held unknown introductions have per-peer/global count limits and a metadata limit. History holds at most 128 records; completed incoming receipts remain available, while disposable history is pruned. Decline memory retains the latest 256 decisions. Total retained metadata and held metadata are each bounded to 16 Mi characters. The producer suite exercises these admission, history, metadata and receipt-preservation controls.

## Code review conclusions

The revoked-peer checks cover signals, connection openings, retries, stale selections and controls. Records end before links close, preventing closure callbacks from scheduling a new attempt for those transfers. Fresh directory inclusion clears revocation only for the re-listed peer.

Asynchronous receive callbacks check current activity after sink opening and writing; completion also checks the originating link. Final assembly checks activity after every file/text await and before publishing the finished payload or notices. Outbound reads check whether their stream was closed before writing bytes. Resume validation uses the actual outbound File/Blob sizes and requires the stream range to fit every entry.

Retention refuses excess new work rather than discarding completed incoming receipts. Record removal deletes associated metadata and speed-history bookkeeping. The retained offer/cancel/decline behavior preserves ordinary retries and resumes within the bounded windows.

## Evidence and limits

- Independent regressions: `tests/security-audit-nearby-independent.test.ts`.
- Final combined suite: `work/security-audit/nearby-independent-final.log` (58/58).
- Final independent rerun and observations: `nearby-independent-final-owned.log`, `nearby-independent-runtime.json`.
- Validation: `nearby-independent-typecheck-final.log`, `nearby-independent-lint-final.log`, `nearby-independent-format-final.log`.
- Machine-readable review: `nearby-independent.json`.

The independent run replaces the browser's actual WebRTC and OPFS APIs with disposable adapters. It verifies the production control framing, state machine and sink lifecycle; browser/network interoperability is outside this worker's verification claim.

Owned changes: the independent regression file and Nearby independent evidence/report files. Production and producer-test changes remain owned by the coordinator/producer. Pending work: none in this review scope. Active wait handles: none.
