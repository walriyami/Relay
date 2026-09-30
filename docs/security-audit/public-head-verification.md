# Public HEAD verification

Result: **6/6 tests passed**, containing **71 real-HTTP HEAD checks**. All **14 public/raw HEAD routes** enumerated from `work/security-audit/route-matrix.json` were exercised. There were 69 checks on registered routes and two checks confirming unsupported pickup GET/HEAD paths return 404. Sixty-six checks compared HEAD with GET; five checked the explicit tus upload HEAD route, which has no GET counterpart. There were no expected-status mismatches, no HEAD response body bytes, and no denied response exposing content-disposition, ETag, Last-Modified, Content-Range, Upload-Offset or Upload-Length. TypeScript, owned-file ESLint and Prettier passed.

Scope: the owned Relay checkout `/Users/riyami/.codex/worktrees/security-audit/Relay`. Only `tests/security-audit-public-head.test.ts` and `work/security-audit/public-head-*` evidence were edited. All users, bearer resources, content, guest cookies and sockets came from disposable normal harness fixtures. No production source/shared test edits, external targets or deployed data were used.

## Observed statuses

| Registered HEAD route                 | Checks | Observed statuses  |
| ------------------------------------- | -----: | ------------------ |
| `/api/s/:token`                       |      5 | 200, 404           |
| `/api/s/:token/nodes/:node/content`   |      6 | 200, 401, 404      |
| `/api/s/:token/nodes/:node/thumbnail` |      6 | 200, 401, 404      |
| `/api/s/:token/zip`                   |      6 | 200, 401, 404      |
| `/api/r/:token`                       |      7 | 200, 404, 410      |
| `/api/r/:token/events`                |      7 | 200, 401, 404      |
| `/api/n/:token`                       |      7 | 200, 404, 410      |
| `/api/n/:token/events`                |      7 | 200, 401, 404, 410 |
| `/api/invitations/:token`             |      5 | 200, 410           |
| `/api/session/device-link/:token`     |      5 | 200, 410           |
| `/uploads/:id`                        |      5 | 200, 401, 404      |
| `/api/health`                         |      1 | 200                |
| `/api/setup`                          |      1 | 200                |
| `/api/pickup/config`                  |      1 | 200                |

`/api/pickup` and `/api/pickup/000000` each returned 404 for both GET and HEAD. The resolver is POST-only; public pickup configuration remains available through GET/HEAD.

## Authorization observations

- Share metadata, content, generated thumbnail and ZIP controls work for valid bearers. Invalid, expired and revoked share tokens return 404. Protected content returns 401 without unlocking. A valid share bearer cannot inspect another resource's node or ZIP folder. These denied HEAD responses expose no content metadata headers.
- Request metadata is intentionally public to a valid request bearer, including with no cookie or an unrelated guest cookie. The event route requires that request's own grant: no/foreign/expired/closed-request grants return 401; an invalid request token returns 404. Expired or closed request metadata returns 410. Both GET and HEAD enforce these same boundaries.
- Nearby public code metadata remains 200 without guest credentials, but unjoined or foreign-cookie GET responses contain no self identity or peers. Matching guests can open events; no/foreign/revoked guest cookies return 401. Expired codes return 410; ended/deleted codes return 404. Public metadata remaining available after guest revocation does not admit that guest to its event stream.
- Invitations return 200 while usable, and 410 for invalid, expired, withdrawn or consumed tokens. Device admission metadata returns 200 for a valid bearer and 410 for invalid, expired, revoked or issuing-session-ended tokens.
- Explicit tus HEAD exposes offset/length only to its owning grant. No credential returns 401; a foreign grant or unknown upload ID returns 404; expired grants return 401. This route deliberately has no GET equivalent.

All HEAD checks ran over real ephemeral HTTP sockets. SSE GET and HEAD checks capture headers, destroy the request, await socket closure and have a two-second timeout. They never use hanging in-process stream injection. Non-streaming GET counterparts use the disposable harness injector to retain normal cookie behavior.

The initial injector-only run included JSON error bodies on HEAD, an injector representation rather than a wire disclosure. Its authorization statuses already matched. Final checks use actual HTTP HEAD responses, which send zero payload bytes even for errors. This was a test-fixture correction, not an application finding.

## Evidence

- New regressions: `tests/security-audit-public-head.test.ts`.
- Final results: `work/security-audit/public-head-final.log` and `public-head-runtime.json`.
- Machine-readable summary: `public-head-verification.json`.
- Validation: `public-head-typecheck-final.log`, `public-head-lint-final.log`, `public-head-format-final.log`.
- Initial injector observations: `public-head-initial.log`, `public-head-initial.json`.

Remaining verified findings: none in this bounded HEAD slice. Pending work: none. Active wait handles: none. The test stores the enumerated route inventory directly so it remains runnable without ignored audit artifacts in a clean checkout.
