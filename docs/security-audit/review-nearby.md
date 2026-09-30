# Nearby audit evidence and task state

Status: source and owned tests frozen for coordinator integration, 2026-09-30.

Objective: verify that revoking a Nearby peer ends established connections and pending/active transfers, validate incoming controls before use, and bound unsolicited transfer metadata. The review used this repository and disposable local fixtures only. Production edits are restricted to `engine.ts`, `link.ts`, and `protocol.ts`; no external targets, deployment, desktop task operations, or occupied application ports were used.

## Confirmed findings and fixes

**N-01 — P1: directory removal left established links and transfers authorized locally.** Before the fix, `setDirectory([])` retained a ready link and an incoming offer for guest, member, and host peers. An accepted receive stored two additional bytes after removal. Server end-invite/remove-guest routes end the guest's event stream and reject later signaling, but a guest that ignores its stream ending could keep using the member's existing data channel. Visibility changes also remove peers from both directories without otherwise closing their established data channels.

Baseline: `nearby-regression-baseline.log` records six failing subtests, including `closed: false`, `status: ready`, `pending: true`, and an active receive with `moved: 2` after directory deletion. The fixture replaces WebRTC setup while running production Link, Lanes, Mux, and engine code.

Fix: `engine.ts:257` cancels active/pending records before closing removed peers' links, drops held offers and owed messages, clears connection retry status, and remembers explicit revocations. Late signals, retries, old controls, and stale local send selections cannot re-admit a revoked peer. A freshly listed peer clears that revocation; an initial introduction can still wait briefly for the asynchronous directory load. Completed receipts remain available. State checks after capacity checks, sink work, and file/text assembly prevent cancelled receives from returning to running/done or producing stale failure notices.

**N-02 — P2: malformed controls escaped the data-channel callback.** An offer containing `folders: [42]` threw `path.replaceAll is not a function`. An accept containing `have: { unexpected: 1 }`, followed by a normal credit message, threw `Cannot read properties of undefined (reading 'size')` in progress calculation. These controls come from an endpoint with an established link, such as an invited guest or a visible member.

Baseline: both exceptions and source stacks are in `nearby-regression-baseline.log`. No code execution or browser filesystem escape was observed.

Fix: `protocol.ts:41` validates control discriminants, IDs, file/folder/preview types and lengths, safe integer byte counts, aggregate offered size, accept offsets, and stream bounds. `link.ts:68` closes the link on malformed controls before forwarding them. `engine.ts:557` additionally requires accept keys to identify this transfer's entries and offsets to fit their actual sizes. Ordinary offer, accept/resume, decline, cancel, done, and valid file/text completion controls pass.

**N-03 — P2: repeated offers accumulated unbounded metadata.** A normal fixture sending 257 different offers retained all 257 pending records. An unknown introduction held 257 offer messages without rejecting excess. The engine retained 136 completed receipts, and all 300 declined IDs stayed in memory. `lastMoved` also retained removed transfer IDs.

Baseline: `nearby-resource-baseline.log` records four failing resource tests: 257 pending records instead of 8; zero immediate rejections instead of 249; an old decline remained remembered after 300 newer decisions; and 136 retained receipts instead of 128.

Fix: admission now permits 8 active/pending receives per peer, 32 active/pending transfers globally, and 128 retained records. Estimated retained metadata is limited to 16 MiB of character accounting. Unknown introductions hold at most 8 offers per peer, 32 globally, and 16 MiB of estimated metadata. Recent decline memory holds 256 IDs. Known transfers resume without consuming new admission slots. Old outbound/failed/cancelled history may be pruned; completed inbound receipts are preserved, and new offers are declined when receipts fill the available slots. Removal/pruning clears `lastMoved` and metadata accounting.

## Verification

- `node_modules/node/bin/node --test tests/security-audit-nearby.test.ts`: 32 tests passed, zero failed; `nearby-regression-fixed.log`.
- Existing disposable server suite `tests/nearby.test.ts`: 5 tests passed; `nearby-server-tests.log`.
- Full TypeScript check passed; `nearby-typecheck.log`.
- Targeted ESLint and Prettier checks passed; `nearby-lint.log` and `nearby-format.log`.
- Controlled delayed Sink adapters separately hold `open`, `write`, and `finish`. Removal closes transport, discards the sink, leaves zero retained bytes, and cannot revive the cancelled transfer. Production engine callbacks, Link, Lanes, and framing still run in these cases.
- Tests also cover queued receive work, pending file reads, late text assembly, own-device automatic acceptance, retained receipts, valid partial resumes, known offers at the admission limit, per-peer/global held and active limits, metadata limits, recent declines, safe history pruning, and per-transfer stream-range overflow.

## Verified/no-evidence coverage and limits

The server suite verifies member visibility/network separation, guest-to-host restrictions, guest CSRF, removal, invitation end/expiry, and stream replacement. Server signal schemas also validate discriminants, SDP/session bounds, and destination IDs. No server-side future-signaling authorization bypass was found in this slice. The cooperative guest's end/leave path calls `stopEngine`; the missing enforcement was on the member's existing connection after its directory changed.

Client revocation takes effect when the authoritative directory update reaches the engine. This worker did not run a real browser ICE transfer; the coordinator owns browser/container verification and independent review. The Node fixture runs the actual control/framing/transfer lifecycle with deterministic local transport setup. The source-level capacity-await race was independently reproduced by the coordinator's verifier and corrected in `accept()` before either outcome is applied.

Changed files: `client/lib/nearby/engine.ts`, `client/lib/nearby/link.ts`, `client/lib/nearby/protocol.ts`, `tests/security-audit-nearby.test.ts`, and this report plus `nearby.json`. No active wait handles. Pending work: coordinator independent validation and integration. No further worker source edits are planned.
