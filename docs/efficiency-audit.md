# Relay efficiency and speed audit

Audit date: 28 September 2026. Scope: the current working implementation, across client, server, storage, background work, previews, and deployment. This audit changes no product code.

## Assessment

Relay already has good foundations for large byte transfers: streaming, resumable offsets, range downloads, bounded preview resources, and a bounded upload UI. The largest demonstrated opportunities are **excessive live refreshes, fixed overhead per small file, and oversized collection metadata**. Optimize these before replacing the database, increasing concurrency, or broadly rewriting rendering.

The strongest findings:

1. A 1,000-file upload triggered **161 session requests and 160 pickup-configuration requests** in approximately 20 seconds. File completion broadcasts invalidate both consumers, including consumers belonging to other connected members.
2. A 10,000-file folder took **191.1 seconds** to save on loopback, although selecting it took 1.3 seconds and added only 24 DOM elements. Small-file completion overhead is the main demonstrated scaling problem.
3. A synthetic 10,000-node collection returned **2.046 MB of JSON**, even though the browser initially renders at most 90 file/folder entries. The same body was **117 KB with gzip**; the supplied gateway excludes every API route from compression.

These are baselines and evidence for prioritization, not measured speedups from proposed changes.

## Measurements and limits

Tests used disposable instances and generated data on macOS arm64, Node 24.21.0, with Chromium for full upload measurements. No user library was modified. The repository had substantial preexisting uncommitted work; HEAD was `4b4b5b8`. Source references below describe the working tree, not that commit alone.

| Check                                                    | Result                                                                                        | Interpretation                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Production build and TypeScript                          | Passed; main JS 584.82 KB raw / 178.21 KB gzip; CSS 99.87 / 18.72 KB                          | Moderate startup payload; secondary to the demonstrated transfer and metadata costs                         |
| 80 MiB file, interrupted upload, process restart, resume | Passed; resumed upload 425 MiB/s; download 1,264 MiB/s                                        | Local streaming path is fast; figures are loopback/cache results, not WAN or NAS capacity                   |
| 1,000-file server scale run                              | 22.186 s; paths, hashes, ZIP entries, and resumed ZIP ranges passed                           | Fixed per-file cost dominates small payloads                                                                |
| 10,000-file browser run                                  | Selection 1.308 s; save 191.098 s; maximum extra DOM elements 24; all paths/payloads verified | Upload UI scales without mounting one row per file                                                          |
| Instrumented 1,000-file browser run                      | 6,103,397 payload bytes; save 19.581 s; 989 HEAD + 989 PATCH requests                         | Eleven zero-byte files need no payload request; nearly every other file incurs two requests                 |
| Background GETs in that run                              | Session 161; pickup config 160; items list 8                                                  | Account/config invalidation is much more frequent than ordinary debounced list refresh                      |
| Browser errors / long tasks in that run                  | No page errors or request failures; one 105 ms long task                                      | A useful local baseline, not a low-end-phone responsiveness guarantee                                       |
| Synthetic 10,000-node item detail                        | 2,046,071 bytes; 117,350 bytes gzip; warm request 25.23 ms                                    | Delivery size matters more than local server execution time here                                            |
| Synthetic library with 10,000 cards, first 60 newest     | Warm median 2.70 ms; first dirty read 71.37 ms                                                | Cached normal listing is already fast at this tested size                                                   |
| Same library, searches                                   | No-match 18.36 ms; matching 10.07 ms                                                          | No evidence yet that a search-engine migration is a priority                                                |
| PDF/device resource suite                                | 24 tests passed across Chromium, Firefox, and WebKit                                          | Includes real 300-page PDFs, shared canvas budgets, cancellation, worker cleanup, and hidden device polling |

Two further disposable HTTP probes tested continuously progressing upload bodies: a 1 MiB PATCH completed with HTTP 204 after 128.3 seconds; a 1.25 MiB PATCH planned to take 160 seconds received HTTP 408 after 150.0 seconds, with its committed offset still zero. These duration-scaled probes establish a long-request cutoff, not an exact production bitrate threshold.

The metadata dataset has repetitive synthetic text and names; its compression ratio is illustrative. Warm list results are medians of five reads with a limit of 60, whereas the Files page uses 200. The browser request-count window includes selection and a 1.5-second final settling interval. The instrumented browser used the direct Node origin, bypassing Caddy, so its uncompressed asset transfers do not characterize the default gateway.

The built asset hashes changed between the initial build and the later browser probe while this shared working tree was active; the measured main bundle retained the same raw size. These results are a working-tree audit, not a certification of one immutable release candidate. No physical phone, WAN, production container, HDD/NAS, or sustained multi-member load benchmark was performed.

## Prioritized improvements

### 1. P1 — Bound account refreshes and share pickup configuration

**Observed:** 321 session/config GETs during one 1,000-file upload. This happens without opening another draft or the pickup-code popover.

Each file finalization calls `publishItemChange`, which publishes the owner's item change and broadcasts `account` to all connected members. The event bus combines events for only 100 ms. App immediately refetches the session, and the visible protection banner independently refetches code configuration. Sequence counters prevent stale responses replacing state but do not prevent requests, parsing, or rerenders. Opening the code form adds another independent configuration consumer.

**User impact:** wasted network traffic, battery and CPU; other users' tabs also do work when someone uploads a folder. Slow connections can accumulate overlapping requests. Shared-capacity updates are valid, but they currently invalidate unrelated settings too broadly.

**Change:** use one in-flight fetch plus a trailing dirty refresh, scheduled at a bounded cadence, initially around 500 ms. Use a maximum delay from the first event rather than continually resetting a debounce during a long upload. Share configuration state and its request across banner and form. Separate deployment-code settings from storage/account invalidation so file completions do not refetch unchanged code configuration.

Preserve the first SSE `ready` catch-up: it closes the gap between the initial snapshot and subscribing. Preserve visible/focus/online reconciliation, immediate feedback from explicit settings changes, and the current config read before code submission. Coalescing should retain a trailing catch-up when an event arrives during an in-flight read.

**Acceptance:** rerun the same upload with multiple member tabs; session refresh starts stay at or below approximately two per second per tab plus bootstrap/completion exceptions; unchanged pickup configuration is not requested per file; no overlapping identical reads. Quota and settings still converge promptly, including reconnect and changes during bootstrap.

**Source:** `server/modules/transfers/receivers.ts:317–336`, `server/modules/transfers/publish.ts:8–12`, `server/lib/events.ts:15–16,36–47`, `client/app/App.tsx:245–254`, `client/features/codes/config.ts:39–51`, `client/features/codes/CodeEntry.tsx:80`, `client/lib/live.ts:159–205`.

### 2. P1 — Reduce fixed work per small file without weakening durability

**Observed:** approximately 20–22 seconds for 1,000 small files, and 191 seconds for 10,000. The 1,000-file browser run performs 989 HEAD requests before 989 PATCH requests. Large-file throughput is far higher relative to byte volume.

**Source-confirmed costs:** new uploads are handed to tus through an existing upload URL, causing offset discovery. Each published file also records a durable cleanup intent, stages a hard link/rename, synchronizes directory entries, and commits publication. SQLite uses `synchronous=FULL`. Node triggers repeatedly execute summary-dirty updates. The audit did not isolate the percentage of time attributable to each cost.

**Change in order:**

1. Avoid redundant offset discovery for a newly created upload whose zero offset is authoritatively known. Keep HEAD reconciliation after interruption, an ambiguous response, retry, or resume. Confirm the supported tus integration path before changing it.
2. Avoid redundant dirty-flag update work when the item is already dirty. Consider a bounded prepared-statement cache for frequently reused SQL, and measure its contribution.
3. Profile fsync/commit latency on the intended storage, then design group commit or a bounded small-file batch path if needed. Batch cleanup intents and publication only where the existing ordering, recovery, and acknowledgement guarantees can be proved. Keep per-file paths and progress semantics.

Do not remove fsync, acknowledge non-durable files, or lower SQLite durability to obtain a better benchmark. The cleanup-intent write must remain durable before its corresponding filesystem staging begins.

**Acceptance:** fewer requests for fresh files and a repeatable reduction in 1,000/10,000-file completion time. Run interruption, restart, cancellation, duplicate-content, storage-integrity, cleanup-failure, and ZIP/hash checks. Test both fast local storage and the actual deployment disk before increasing concurrency.

**Source:** `client/lib/transfers.ts:498–505`, `server/storage/blobs.ts:418–453`, `server/modules/transfers/receivers.ts:300–336`, `server/db/database.ts:48,89–101`, `server/db/schema.sql:200–214`.

### 3. P1 — Deliver collection metadata in proportion to what is visible

**Observed:** a 10,000-node detail response is about 2 MB. The API returns every ready node, including text content. EntryBrowser constructs indexes and ancestor totals for the full response, then displays an initial 90 entries. Its aggregate work is already memoized by `nodes`; sorting the current folder's children is not.

**User impact:** opening a large saved collection, received collection, or public share waits for unnecessary metadata transfer and JSON work. Limiting rendered tiles alone does not bound network or data-processing costs.

**Change:** first allow compression for selected metadata JSON responses at the gateway, while preserving the original representation of SSE, upload bodies, downloads, and range responses. Then introduce folder-scoped/cursor-paginated child metadata with server-provided counts/totals. Fetch text bodies when needed. Memoize sorted children in the existing UI as a small interim improvement.

Keep breadcrumbs, nested-folder totals, selected-file navigation, public access checks, and archive downloads correct when only part of the tree is loaded. A scoped API is a larger change than compression and should follow it separately.

**Acceptance:** real deployment responses negotiate compression correctly; SSE remains live and byte ranges/ZIPs remain exact. For a 10,000-node collection, the initial browser payload and processing scale with the first visible page rather than all nodes. Verify member, delivery, and public-share surfaces.

**Source:** `server/modules/library/items.ts:108–120,197–203`, `client/components/EntryBrowser.tsx:40–68`, `proxy/Caddyfile:14–19`.

### 4. P2 — Match chunk sizing and total upload concurrency to slow uplinks

The browser sends **8 MiB chunks** and permits four regular files or two files larger than 64 MiB concurrently **per transfer**. The server's maximum accepted chunk is 32 MiB; that is not the browser's chosen chunk size. Fastify has a 120-second request timeout, but observed enforcement is not an exact 120-second cutoff: one progressing request succeeded after 128.3 seconds, while a longer one received 408 at 150.0 seconds and retained offset zero. At 0.5 Mbps, transmitting 8 MiB takes about 134 seconds before other overhead. Two active streams sharing a 1 Mbps uplink can reach that duration, and multiple transfers multiply the slots again. The probes do not establish that every 134-second request fails.

**Change:** add a fair upload budget across transfers in a tab and adapt chunks/concurrency to measured upload conditions. Choose an initial chunk small enough to discover a slow link. Align the active-request deadline with supported chunk duration and keep an inactivity bound; merely increasing every timeout does not resolve congestion. Do not reduce chunks globally without measuring the resulting small-file/fast-LAN request cost.

**Acceptance:** two simultaneous large transfers complete on 0.5/1 Mbps throttled uplinks without a repeated timeout/retry cycle; pause/resume/cancel remain responsive; a small queued transfer is not starved. Record per-tab and multi-tab behavior separately.

**Evidence status:** long-body rejection was reproduced on actual authenticated HTTP PATCH requests against a disposable server, configured with both request and socket timeouts of 120,000 ms. The accepted shorter probe and rejected longer probe bracket observed behavior; no physical mobile-network measurement or exact browser bitrate threshold was established.

**Source:** `client/lib/transfers.ts:117,131,425–449,503`, `server/app.ts:49–52`, `shared/model.ts:21`.

### 5. P2 — Avoid repeating selection work while the user types

Composer's automatic name depends on the entire text value. Each keystroke can flatten the selected files, resolve unique paths, and examine top-level entries again. Directory drag/drop also walks file reads serially. The successful 10,000-file selection benchmark used the folder input and does **not** validate drag/drop speed or typing after selection.

**Change:** cache selection-derived paths/name inputs when the selection changes, then combine them with text presence or the necessary text-derived name. Walk dropped folder entries with a small bounded concurrency, retaining deterministic order, collision handling, empty folders, skipped-entry reporting, and progress.

**Acceptance:** compare typing latency with a 10,000-file selection and actual folder drops on supported browsers; no long task attributable to full-selection rescanning on each keystroke. The selected path set and generated name must remain identical.

**Evidence status:** source-confirmed repeated work; low-end-device impact is not yet measured.

**Source:** `client/features/send/Composer.tsx:160–168`, `client/lib/transfers.ts:234–265`, `client/drop-selection.ts:19–34,47–52`.

### 6. P2 — Index recurring maintenance and bound cleanup work

Maintenance runs in the same process as synchronous SQLite queries. Terminal-transfer expiry, expired tab cleanup, login-code/invite/grant expiry, and global activity expiry have query shapes not covered by the existing indexes. SQLite query-plan inspection confirms table scans; tab cleanup can scan transfers through its correlated lookup because the existing `transfers(tab)` index covers only open transfers.

**Change:** add targeted expiry-leading indexes and a full transfer-tab lookup index, or restructure the cleanup query equivalently. The login-code `expires OR revoked` predicate needs both branches addressed; an expiry index alone does not solve it. Where retained volumes justify it, delete in bounded batches with yields between transactions. Validate index write cost before adding redundant indexes to every table.

**User impact:** helps avoid periodic request stalls on busy or long-lived installations. This is a scale-dependent risk, not a measured latency problem for a small household installation.

**Acceptance:** query plans use appropriate indexes at realistic retained volumes; p95 request latency stays stable during sweeps; cleanup still completes within its required retention window and respects foreign keys.

**Source:** `server/modules/transfers/lifecycle.ts:314–317`, `server/modules/auth/index.ts:22–29`, `server/modules/activity/index.ts:37–38`, `server/db/schema.sql:103,235,251–252,334`, `server/app.ts:187–216`.

## Profile before promoting these improvements

| Opportunity                   | Current evidence and suggested next step                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cold image grids              | One renderer is intentional, but each rendition starts a new worker which eagerly imports both Sharp and HEIC decoding. Measure first-grid latency by format; lazy-load HEIC for HEIF input before considering a recycled worker. Preserve queue, pixel, memory, timeout, cancellation, and failure-cache limits. Sources: `server/modules/downloads/thumbnails.ts:18–25,51–95`; `thumbnail-worker.ts:3–4,18–40`. |
| Startup/public-page payload   | Main JS is 178 KB gzip. Settings/Admin and PDF code already load separately. Tus is dynamically imported immediately after startup, even on read-only pages; defer it to upload intent or an appropriate idle period if mobile traces show contention. Route splitting must preserve the existing failed-import/offline recovery behavior. Source: `client/lib/transfers.ts:482–490`.                             |
| Long PDF page shells          | Canvas rendering is bounded and the cross-browser resource suite passes. Up to 300 shells/observers remain mounted. Only virtualize these if phone profiles show meaningful layout/observer cost, preserving scroll position and navigation. Source: `client/components/PdfPreview.tsx:150,228`.                                                                                                                  |
| Large retained links/requests | Their list views fetch whole lists, unlike the paginated Files page; link history has a display limit. Measure realistic retained volumes before adding server pagination. Shared live-query coalescing also benefits these pages. Sources: `client/features/links/LinksPage.tsx:15,43`; `client/features/requests/RequestsPage.tsx:34`.                                                                          |
| Search and sort               | Synthetic warm 10,000-card queries are fast. Keep summary caching; measure large real text libraries and non-default sorts before adding FTS, denormalized sort columns, or changing DB architecture.                                                                                                                                                                                                             |

Also measure restart time with a large stored library: startup reconciliation enumerates the blob and thumbnail trees before serving (`server/storage/blobs.ts:490–520`, `server/app.ts:207–215`). The small-fixture 213 ms restart does not establish restart performance at high object counts. Consider incremental enumeration or deferring only nonessential cleanup if that measurement warrants it, preserving integrity checks required before serving.

The theoretical queued-task suffix rescan for huge batches of files each exceeding 64 MiB is not a priority: it does not explain the measured small-file slowdown. Neither a generic React rewrite nor a database replacement is supported by this audit.

## Coverage

| Area                                              | Review and outcome                                                                                                                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Composer, files/folders/text, progress            | Source review plus 1,000/10,000-file browser runs; bounded DOM confirmed; findings 1, 2, 5                                                                                           |
| Upload, retry, interruption, resume, cancellation | Streaming/protocol/durability review; real interrupted transfer and process restart passed; findings 2, 4                                                                            |
| Direct delivery, live presence, multiple tabs     | Event/subscription review; global invalidation amplification confirmed in one tab; multi-member load remains a follow-up for finding 1                                               |
| Files, search, folders, Trash, retention          | Synthetic actual-API benchmarks and query/source review; cached list performance good; findings 3, 6                                                                                 |
| Links, public shares, guest requests              | Shared metadata, upload, live refresh, access and list paths reviewed; inherit findings 1–4; retained-list scale remains unmeasured                                                  |
| Image/HEIC, PDF, media previews                   | Worker/queue/range/resource review; PDF/device resource suite passed on three browsers; image cold-start opportunity remains a hypothesis                                            |
| File and folder/ZIP downloads                     | SHA-256, ZIP entry/payload verification, Python archive reader, and resumed range checks passed; preserve streaming/uncompressed ZIP range behavior                                  |
| Auth, setup, join, devices, pickup codes          | Bootstrap and subscriptions reviewed; device visibility/resource checks passed; session/config amplification is the significant issue                                                |
| Settings, admin, usage, activity                  | Refresh/query paths reviewed; account events can invalidate these views too; visibility-aware polling and aggregate reporting already exist; high-volume operational load unmeasured |
| Storage, deduplication, integrity, cleanup        | Durable staging/publication and cleanup/query review; safe amortization and maintenance indexes recommended; no durability shortcuts                                                 |
| Build, assets, gateway, deployment                | Production build/typecheck passed; bundle sizes and Caddy compression inspected; no deployed-container or host-storage benchmark                                                     |

## Recommended sequence

1. **First pass:** bounded refreshes/shared config, selective metadata compression, cached selection-derived work. These address demonstrated or directly avoidable work with relatively narrow changes.
2. **Transfer pass:** fresh-upload offset optimization, fair global upload scheduling, slow-link chunk sizing. Measure request count and elapsed time separately.
3. **Storage and large-library pass:** profile durable per-file costs, design safe batching if warranted, add justified maintenance indexes, and introduce folder-scoped metadata.
4. **Device profiling:** image cold grids, public-page startup, very large retained lists, and PDF shell virtualization only where measurements establish benefit.

Repeat the same disposable baselines after each pass and retain the outputs. Compare correctness and freshness as well as speed. Establish phone/WAN and deployment-disk baselines before setting absolute production performance targets.

## Evidence and reproduction

Audit-local evidence is in `work/efficiency-audit/` (scratch files may be ignored by Git):

- `build.log`: `npm run build`.
- `scale.log`: `npm run verify:scale -- --size 80MiB --files 1000`.
- `browser-scale.log`: `npm run verify:browser-scale -- --files 10000 --use-dist`.
- `browser-probe.ts` and `browser-results.json`: instrumented upload requests and browser timings; run with `node_modules/.bin/node work/efficiency-audit/browser-probe.ts` after building.
- `metadata-benchmark.ts` and `metadata-results.json`: disposable synthetic API timings and response sizes; run with `node_modules/.bin/node work/efficiency-audit/metadata-benchmark.ts`.
- `resources.log`: `npm run test:resources` — 24 passed.
- `server/request-timeout-probe.json` and `server/request-timeout-probe-long.json`: actual HTTP PATCH results, elapsed times, bytes sent, and committed offsets for the slow-request probes.

This is a performance audit and implementation roadmap. Proposed improvements have not been implemented or benchmarked, and this report is not a release or security certification.
