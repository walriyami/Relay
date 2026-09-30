# Endpoint and actor coverage

All 136 registered HTTP operations (88 contract endpoints, including raw routes and automatic HEAD) are accounted for across 15 actor classes. Candidate application commit: 427ac58f32fb1b90be4320ec582b5b141779d7b0. The exact final server suite passed 494 tests with zero failures; its log and source hashes are recorded in coverage.json.

The reconciled global matrix asserts 849 negative requests. These assertions use missing resource IDs and test common authentication, administrator, CSRF, origin and Host hooks. They do not demonstrate owner isolation, valid capability processing or every resource state.

114 operations have an additional manually attributed resource, capability, lifecycle or input-security assertion. 134 operations were observed by the successful observation-slice preload. A feature/setup observation is never counted as an attack or attributed assertion. Real HTTP/socket tests can have curated assertions without preload records.

| Strongest cell category    | Cells |
| -------------------------- | ----: |
| boundary-asserted          |   902 |
| security-property-asserted |    48 |
| allowed-control-asserted   |     9 |
| observed-request-only      |    56 |
| read-only-reviewed         |    13 |
| not-checked                |  1012 |

The separate public HEAD supplement passed 6/6 tests: all 14 public/raw HEAD routes, 69 registered-route HEAD checks, 66 GET/HEAD comparisons and five explicit tus HEAD controls. Two unsupported pickup GET/HEAD probes are reported separately and are not counted as registered operations. No expected-status mismatch, HEAD body or denied sensitive-header exposure was observed.

The wide endpoint-roles.csv is an index. endpoint-actor-coverage.csv carries every endpoint, actor, category, test source/result and limitation; coverage.json preserves multiple evidence categories in each cell. A cell can contain an asserted boundary plus observed control traffic. Categories describe evidence strength, not a security verdict.

Request observations come from a separate successful 16-file slice, whose test-file names and hashes are recorded. Instrumentation-sensitive callback/counter/cwd tests are excluded from that slice. Actual security assertions come from the normal uninstrumented final suite or individually recorded successful supplemental assertion suites. Interrupted or failed instrumented runs are excluded.

The preload records a best-effort principal at request start, so a bearer request may appear anonymous, a revoked session loses its member label, and only selected resource tables detect foreign owners. It misses direct Fastify injection, real HTTP/socket traffic and client-only Nearby data channels. Manually attributed rules correct the scope without relabeling all observations. Credentials, bodies, concrete IDs/tokens, fixture usernames and unfiltered stacks are absent from delivered coverage files.

A passed assertion covers its named scenario only. Unchecked actor cells include intentionally inapplicable authority combinations; they are disclosed instead of being called reviewed. Read-only review is limited to the explicit account verifier's source review. Browser, network protocol, native decoder fuzzing, deployed authenticated roles, sustained denial-of-service, deployment privileges and external/cloud boundaries remain separate scope/limitations in the coordinator report.

## Operations without an additional curated security assertion

These operations may have global-hook assertions and observed feature traffic. This list is a coverage gap list, not a list of vulnerable operations. No automatic HEAD assertion is inherited from GET.

- HEAD /api/health
- HEAD /api/session
- HEAD /api/setup
- HEAD /api/items
- GET /api/account/passkeys
- HEAD /api/account/passkeys
- HEAD /api/activity
- HEAD /api/admin
- HEAD /api/admin/invites
- HEAD /api/admin/usage
- HEAD /api/login-codes
- HEAD /api/login-codes/:id/status
- HEAD /api/local/check
- HEAD /api/links
- HEAD /api/devices
- HEAD /api/deliveries
- HEAD /api/events
- HEAD /api/requests
- HEAD /api/usage
- HEAD /api/nearby
- HEAD /api/pickup/config
- OPTIONS /uploads/:id
